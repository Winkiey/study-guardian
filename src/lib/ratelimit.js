/**
 * 极简令牌桶限流。
 *
 * 为什么需要：这个平台常跑在「按流量计费」的云服务器上（出站 ¥0.8/GB 那种），
 * 而它原本**一点限流都没有** —— 任何人可以无限次请求：
 * 端口扫描、暴力试密码、反复拉静态资源，全都会直接变成账单上的钱。
 * 实测：5Mbps 带宽被打满一整天 = ¥43；100Mbps = ¥864。
 *
 * 零依赖：一个 Map + 令牌桶就够了。单用户自用、单进程，不需要 Redis 那套。
 *
 * 为什么用令牌桶而不是「每分钟计数器」：
 * 计数器在窗口边界会漏 —— 59 秒打满一次、61 秒再打满一次，
 * 相当于瞬间来了两倍流量。令牌桶是匀速回填的，没有这个缝。
 */

/**
 * 取用于限流的客户端标识。
 *
 * ⚠️ 这里**故意不用 http.js 的 clientIp()**：那个函数无条件信任
 * `X-Forwarded-For`（记日志无所谓），但用来限流就是致命的 ——
 * 攻击者每次请求伪造一个不同的 XFF 值，就能每次都拿到一个全新的桶，
 * 限流等于没做。
 *
 * 所以默认只认 `socket.remoteAddress`，这个值是 TCP 连接给的，伪造不了。
 * 只有在确实部署了反向代理（Caddy / Nginx）时，才打开 TRUST_PROXY，
 * 并取 XFF 的**最后一个**值 ——
 * 反向代理是「把客户端 IP 追加到末尾」，所以末尾那个才是代理亲眼看到的真实 IP；
 * 开头的值是客户端自己塞进来的，不可信。
 */
export function limiterKey(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const hops = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 建一个令牌桶限流器。
 *
 * @param {object} opts
 * @param {number} opts.capacity 桶容量 = 允许的突发请求数
 * @param {number} opts.perMinute 匀速回填速度（每分钟补充多少个令牌）
 * @param {string} opts.name 仅用于报错信息
 */
export function createRateLimiter({ capacity, perMinute, name = 'limiter' }) {
  if (!(capacity > 0) || !(perMinute > 0)) {
    throw new Error(`${name}: capacity 和 perMinute 必须是正数`);
  }

  /** key -> { tokens, last } */
  const buckets = new Map();

  /** 桶空到「慢慢等会满」的那个时间上限，用于清理长时间不用的条目 */
  const IDLE_MS = Math.max(60_000, (capacity / perMinute) * 60_000 * 4);

  /**
   * 消耗一个令牌。
   * @returns {{allowed: boolean, retryAfterSec: number, remaining: number}}
   */
  function take(key, now = Date.now()) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, last: now };
      buckets.set(key, bucket);
    } else {
      const elapsedMin = (now - bucket.last) / 60_000;
      if (elapsedMin > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedMin * perMinute);
        bucket.last = now;
      }
    }

    if (bucket.tokens < 1) {
      const deficit = 1 - bucket.tokens;
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((deficit / perMinute) * 60)),
        remaining: 0,
      };
    }

    bucket.tokens -= 1;
    return { allowed: true, retryAfterSec: 0, remaining: Math.floor(bucket.tokens) };
  }

  /**
   * 清掉长时间没动过的桶，避免 Map 无限增长（被大量不同 IP 扫时会累积）。
   *
   * ⚠️ 必须**按时间回填之后再判断**能不能删。
   * 第一版只看了桶里当前剩多少令牌，于是「用过一次、之后没人再碰」的桶
   * 令牌永远停在容量之下，永远不满足「已回满」的条件 —— 一个都删不掉，
   * Map 只涨不降。（这个 bug 是单元测试逼出来的。）
   *
   * 判断依据是「现在把它删掉，和留着它在效果上等价吗」：
   * 只有已经回满、且闲置够久的桶才符合。
   * 还在被限流（桶没回满）的条目一定要留着，删了就等于解除限流。
   */
  function sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, bucket] of buckets) {
      const elapsedMin = (now - bucket.last) / 60_000;
      const tokens = elapsedMin > 0
        ? Math.min(capacity, bucket.tokens + elapsedMin * perMinute)
        : bucket.tokens;

      if (tokens >= capacity && now - bucket.last > IDLE_MS) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    name,
    capacity,
    perMinute,
    take,
    sweep,
    get size() { return buckets.size; },
    /** 测试用 */
    reset() { buckets.clear(); },
  };
}

/**
 * 这个请求该用哪个限流器（以及限额是多少）。
 *
 * 分两档：
 *   - 普通请求：宽松。打开一个 71 页的课件就要 70 多次请求，限太紧会误伤自己。
 *   - 登录接口：严格。这是唯一能「试出密码」的入口，
 *     而本项目没有登录失败锁定，所以这里必须自己兜住。
 */
export function pickLimiter(pathname, method, { general, auth }) {
  // 注册也走严格档：它同样能刷（批量建号、把磁盘和数据库当免费空间用），
  // 而且不严的话「邀请码」就只是个摆设 —— 可以无限次试。
  if (method === 'POST' && (pathname === '/login' || pathname === '/setup' || pathname === '/register')) {
    return auth;
  }
  return general;
}
