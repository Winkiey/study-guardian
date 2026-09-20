/**
 * 设置页。
 *
 * 分成五块（锚点导航就是按这个顺序）：
 *   1. 学期 —— 周次计算的基础
 *   2. 作息时间
 *   3. 手机提醒 —— Bark / 邮件 / 企业微信等渠道的配置与测试
 *   4. 课表导入导出 —— ICS / CSV
 *   5. 系统 —— 文件预览能力、存储占用、账号与密码
 *
 * ⚠️ 这个页面**只写给用户看**。
 * 服务器路径、运行时版本、数据目录怎么备份、怎么装转换器这类
 * 「运维这台机器」的内容不要放在这里 —— 那是 DEPLOY.md 的事。
 * 用户是拿手机看课表的同学，他既不运维服务器，也看不到它的文件系统；
 * 混进来只会让人以为「我得去做点什么」，而其实什么都不用做。
 */

import { escapeHtml } from '../../lib/http.js';
import { PASSWORD_MIN_LENGTH } from '../../lib/auth.js';
import { icon, pageHeader, card, emptyState, badge, field } from '../layout.js';
import { SETTING_DEFS } from '../../lib/settings.js';
import { humanSize } from '../../lib/files.js';
import { humanizeOffset, todayStr } from '../../lib/datetime.js';
import { weekOfDate } from '../../lib/weeks.js';
import { timeToMinutes } from '../../lib/periods.js';
import { CHANNELS } from '../../lib/notify/channels.js';

/** 判断日期是不是星期一（学期起始日必须是周一，否则周次会整体偏移） */
function isMonday(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return true; // 格式不对时交给输入框的类型校验去管，这里不重复报错
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getDay() === 1;
}

/** 把一节课的开始/结束时间算成时长标签，例如「45 分钟」 */
function periodLengthLabel(start, end) {
  const minutes = timeToMinutes(end) - timeToMinutes(start);
  if (!Number.isFinite(minutes) || minutes <= 0) return '时间有误';
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function settingsPage({
  user,
  settings,
  terms,
  channels,
  converter,
  scheduler,
  logs,
  logStats,
  storage,
  subscription,
  officeConvertEnabled,
  periodSchedule = [],
  defaultPeriodSchedule = [],
  hasCustomPeriods = false,
}) {
  const body = `
${pageHeader({
    title: '设置',
    subtitle: '学期、作息时间、手机提醒、课表导入导出与账号',
  })}

<nav class="anchor-nav" aria-label="设置分区">
  <a href="#term">学期</a>
  <a href="#periods">作息时间</a>
  <a href="#notify">手机提醒</a>
  <a href="#schedule">发送情况</a>
  <a href="#calendar">课表导入导出</a>
  <a href="#appearance">外观</a>
  <a href="#prefs">个人偏好</a>
  <a href="#system">系统</a>
</nav>

<!-- ============ 学期 ============ -->
<section id="term">
${card({
    title: '学期',
    actions: `<button type="button" class="btn btn--outline btn--sm" data-new-term>${icon('plus', 15)}<span>新增学期</span></button>`,
    body: terms.length
      // 六列的表格在手机上装不下，而 .card 有 overflow:hidden ——
      // 不套滚动容器的话右边的列会被**直接裁掉**：既看不见，也滚不动，
      // 用户只会觉得「编辑按钮不见了」。
      // .table-scroll 是本项目现成的类（发送记录表在用），这里直接复用。
      ? `<div class="table-scroll">
      <table class="table">
      <thead><tr><th>学期</th><th>第一周周一</th><th>周数</th><th>现在第几周</th><th>状态</th><th></th></tr></thead>
      <tbody>
        ${terms.map((t) => {
        const currentWeek = weekOfDate(t.start_date, todayStr());
        const weekLabel = currentWeek < 1
          ? '<span class="muted">还没开学</span>'
          : (currentWeek > t.week_count
            ? '<span class="muted">已结束</span>'
            : `第 <strong>${currentWeek}</strong> 周`);
        return `
          <tr class="${t.is_active ? 'is-active-row' : ''}">
            <td>${escapeHtml(t.name)}</td>
            <td>${escapeHtml(t.start_date)}${isMonday(t.start_date) ? '' : ' <span class="badge badge--warn" title="起始日不是周一，周次会整体偏移">非周一</span>'}</td>
            <td>${t.week_count} 周</td>
            <td>${weekLabel}</td>
            <td>${t.is_active ? badge('当前学期', 'primary') : ''}</td>
            <td class="table__actions">
              ${t.is_active ? '' : `<button type="button" class="btn btn--ghost btn--sm" data-activate-term="${t.id}">设为当前</button>`}
              <button type="button" class="btn btn--ghost btn--sm" data-edit-term="${t.id}">${icon('edit', 15)}<span>编辑</span></button>
              <button type="button" class="btn btn--ghost btn--sm btn--icon" data-delete-term="${t.id}" title="删除">${icon('trash', 15)}</button>
            </td>
          </tr>`;
      }).join('')}
      </tbody>
    </table>
    </div>
    <p class="field__help">
      「第一周周一」是课表周次计算的基准，<strong>必须是星期一</strong>。教务处的校历上会写「第 1 教学周」，那就是它。
      填错的话整个课表的周次都会偏——比如今天明明已经是第 2 周，页面却显示第 1 周，
      多半就是这个日期差了一周，点「编辑」改一下即可。
    </p>`
      : emptyState({
        icon: 'calendar',
        title: '还没有学期',
        description: '设置学期后才能按「第几周」过滤课表。如果你导入的课表带周次信息，多半也需要它。',
        action: `<button type="button" class="btn btn--primary" data-new-term>${icon('plus', 17)}<span>新增学期</span></button>`,
      }),
  })}
</section>

<!-- ============ 作息时间表 ============ -->
<section id="periods" class="anchor-section">
${card({
    title: '作息时间表',
    actions: hasCustomPeriods
      ? badge('已自定义', 'primary')
      : badge('使用默认值', 'neutral'),
    body: `
  <p class="field__help mb-sm">
    <strong>一节一节地填</strong>：第 1 节几点到几点、第 2 节几点到几点……每个学校都不一样，所以这里可以改。
    影响两件事：
  </p>
  <ul class="hint-list">
    <li>导入课表时，教务系统写「第 3-4 节」「第 5-7 节」的会按这里的每一节换算成具体时间</li>
    <li>课程表页的时间轴按这里的节次分行，跨节次的课会占对应行数的高度</li>
  </ul>
  <p class="field__help">
    为什么是「一节一行」而不是「第1-2节一行」：真实课表里有第 5-6 节、也有第 5-7 节，
    只有把每一节单独定义，任意跨度才能算对。
    已经导入的课程不会自动跟着变——去课程详情页点「编辑上课时间」可以直接改单门课的时间。
  </p>

  <form class="form mt-md" data-periods-form>
    <div class="period-table">
      <div class="period-table__head" aria-hidden="true">
        <span>节次</span><span>开始</span><span>结束</span><span>时长</span><span></span>
      </div>
      <div class="period-rows" data-period-rows>
        ${/* ⚠️ 每一行的读屏标签必须带上节次。
             原来 12 行的 aria-label 全是「开始时间」「结束时间」，
             读屏用户在表单元素列表里听到的是 12 个一模一样的「开始时间」，
             根本分不清在改第几节 —— 「第 X 节」那几个字是**文本节点**，
             读屏不会把它算进输入框的名字里。 */ ''}
        ${periodSchedule.map((p) => `
          <div class="period-row" data-period-row>
            <div class="period-row__index">
              第 <input class="input input--period-index" type="number" min="1" max="30" name="p_index"
                        value="${escapeHtml(String(p.index))}" aria-label="第 ${escapeHtml(String(p.index))} 节的节次"> 节
            </div>
            <input class="input" type="time" name="p_start" value="${escapeHtml(p.start)}" aria-label="第 ${escapeHtml(String(p.index))} 节开始时间">
            <input class="input" type="time" name="p_end" value="${escapeHtml(p.end)}" aria-label="第 ${escapeHtml(String(p.index))} 节结束时间">
            <span class="period-row__len" data-period-len>${periodLengthLabel(p.start, p.end)}</span>
            <button type="button" class="btn btn--ghost btn--icon" data-remove-period title="删除第 ${escapeHtml(String(p.index))} 节" aria-label="删除第 ${escapeHtml(String(p.index))} 节">${icon('trash', 15)}</button>
          </div>`).join('')}
      </div>
    </div>

    <div class="btn-row">
      <button type="button" class="btn btn--outline btn--sm" data-add-period>${icon('plus', 15)}<span>添加一节</span></button>
      <button type="button" class="btn btn--outline btn--sm" data-auto-fill-periods>${icon('refresh', 15)}<span>按上一节自动推算下一节</span></button>
      <button type="button" class="btn btn--outline btn--sm" data-reset-periods>${icon('refresh', 15)}<span>恢复成内置默认</span></button>
    </div>

    <div class="notice notice--error notice--compact" data-periods-error hidden>
      <div class="notice__icon">${icon('alert', 16)}</div>
      <div class="notice__body" data-periods-error-text></div>
    </div>

    <div class="form__actions">
      <button type="submit" class="btn btn--primary">保存作息时间表</button>
    </div>
  </form>

  <details class="details mt-md">
    <summary>内置默认值长什么样（${defaultPeriodSchedule.length} 节）</summary>
    <table class="table table--compact">
      <thead><tr><th>节次</th><th>时间</th></tr></thead>
      <tbody>
        ${defaultPeriodSchedule.map((p) => `
          <tr>
            <td>第 ${p.index} 节</td>
            <td>${escapeHtml(p.start)} - ${escapeHtml(p.end)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </details>`,
  })}
</section>

<!-- ============ 手机提醒 ============ -->
<section id="notify" class="anchor-section">
${card({
    title: '手机提醒渠道',
    actions: `<button type="button" class="btn btn--primary btn--sm" data-new-channel>${icon('plus', 15)}<span>添加渠道</span></button>`,
    body: `
  ${channels.length === 0 ? `
    <div class="notice notice--warn">
      <div class="notice__icon">${icon('alert', 20)}</div>
      <div class="notice__body">
        <strong>还没有配置任何提醒渠道</strong>
        <p>作业 DDL 提醒需要一个「发送出口」。iPhone 用户最省事的是 <strong>Bark</strong>：
        在 App Store 搜索 Bark 装上，打开后首页会显示一串 Key，把它填进来就行，不需要注册账号。</p>
        <button type="button" class="btn btn--primary btn--sm" data-new-channel data-preselect="bark">${icon('plus', 15)}<span>配置 Bark（推荐）</span></button>
      </div>
    </div>` : ''}

  <div class="channel-list">
    ${channels.map(channelRow).join('')}
  </div>

  ${channels.length ? `
  <div class="channel-test-row">
    <button type="button" class="btn btn--outline btn--sm" data-test-all-channels>${icon('bell', 15)}<span>给所有渠道发一条测试消息</span></button>
    <span class="muted small">测通了再放心用。测试消息会立刻发到你的手机。</span>
  </div>` : ''}

  <details class="details mt-md">
    <summary>看看都支持哪些渠道</summary>
    <div class="channel-catalog">
      ${CHANNELS.map((c) => `
        <div class="catalog-item">
          <div class="catalog-item__head">
            <strong>${escapeHtml(c.label)}</strong>
            ${c.badge ? badge(c.badge, 'primary') : ''}
          </div>
          <p class="small muted">${escapeHtml(c.tagline)}</p>
          ${c.docs ? `<a class="link small" href="${escapeHtml(c.docs)}" target="_blank" rel="noopener">申请地址 ${icon('external', 12)}</a>` : ''}
        </div>`).join('')}
    </div>
  </details>`,
  })}
</section>

<!-- ============ 提醒调度 ============ -->
<section id="schedule" class="anchor-section">
${card({
    title: '提醒发送情况',
    body: `
  <div class="status-row">
    <div class="status-item">
      <span class="status-dot ${scheduler.running ? 'is-on' : 'is-off'}"></span>
      <div>
        <strong>${scheduler.running ? '提醒服务正常' : '提醒服务已停止'}</strong>
        <p class="muted small">${scheduler.running
        ? '快到截止时间的作业会按你设的提前量发到上面选的渠道。'
        : '现在不会有提醒发出去，请联系站点管理员。'}</p>
      </div>
    </div>
    <button type="button" class="btn btn--outline btn--sm" data-run-scheduler>${icon('refresh', 15)}<span>现在检查一次</span></button>
  </div>

  <div class="log-stats">
    <span>最近 7 天：共 ${logStats.total} 条，成功 ${logStats.success} 条${logStats.failed ? `，失败 <span class="text-danger">${logStats.failed}</span> 条` : ''}</span>
  </div>

  ${logs.length ? `
  <details class="details" open>
    <summary>发送记录（最近 ${logs.length} 条）</summary>
    <div class="table-scroll">
      <table class="table table--compact">
        <thead><tr><th>时间</th><th>渠道</th><th>内容</th><th>结果</th></tr></thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td class="nowrap">${escapeHtml(l.created_at)}</td>
              <td>${escapeHtml(l.channel_type)}</td>
              <td>${escapeHtml((l.title || '').slice(0, 60))}</td>
              <td>${l.ok ? badge('成功', 'success') : `<span class="text-danger" title="${escapeHtml(l.detail)}">${escapeHtml((l.detail || '失败').slice(0, 80))}</span>`}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </details>` : '<p class="muted small">还没有发送记录。配好渠道之后，可以点「现在检查一次」，或者在渠道列表里发一条测试消息。</p>'}`,
  })}
</section>

<!-- ============ 课表导入导出 ============ -->
<section id="calendar" class="anchor-section">
<div class="grid grid--2">
  ${card({
    title: '导入课表',
    body: `
    <p class="small">三种方式，按你的情况选：</p>
    <ul class="hint-list">
      <li><strong>.ics 文件</strong> —— 教务处/手机日历能导出的话最省事，自动识别课程、时间、周次</li>
      <li><strong>CSV / Excel</strong> —— 有现成模板，从教务系统复制粘贴也行</li>
      <li><strong>手动添加</strong> —— 课少的时候最快</li>
    </ul>
    <div class="btn-row">
      <a class="btn btn--primary btn--sm" href="/import">${icon('upload', 16)}<span>去导入</span></a>
      <a class="btn btn--outline btn--sm" href="/import?template=csv">${icon('download', 16)}<span>下载 CSV 模板</span></a>
    </div>`,
  })}

  ${card({
    title: '导出到手机日历',
    body: `
    <p class="small">把课表和作业 DDL 导出成 <code>.ics</code>，导进 iPhone 自带的「日历」App。</p>
    <div class="btn-row">
      <a class="btn btn--primary btn--sm" href="/calendar/download.ics">${icon('download', 16)}<span>下载 .ics</span></a>
      <button type="button" class="btn btn--outline btn--sm" data-copy="${escapeHtml(subscription.webcal)}">${icon('external', 16)}<span>复制订阅链接</span></button>
    </div>
    <div class="field mt-sm">
      <label class="field__label">订阅地址（iPhone：设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历）</label>
      <input class="input input--mono" readonly value="${escapeHtml(subscription.webcal)}" onclick="this.select()">
    </div>
    <p class="field__help">
      <strong>重要区别：</strong>下载后<strong>导入</strong>的日历事件自带闹钟，到点会响；
      用<strong>订阅</strong>方式添加的日历，iOS 会忽略事件里的闹钟，只能用来看课表。
      作业提醒请依赖 Bark 这类推送渠道。
    </p>
    <p class="field__help">
      ⚠️ 订阅地址本身就是钥匙：它<strong>不需要登录</strong>就能看到你的课表和作业
      （手机日历不会带登录信息，所以只能这样），有效期一年。
      别截图发出去，也别粘到群里。
    </p>
    <div class="btn-row mt-sm">
      <button type="button" class="btn btn--outline btn--sm" data-regenerate-calendar>
        ${icon('refresh', 16)}<span>重新生成订阅链接</span>
      </button>
    </div>
    <p class="field__help">
      怀疑链接被谁抄走了（截图过、投屏过、发给过同学、在公共 WiFi 上用过），
      点这个按钮：<strong>以前发出去的所有订阅链接立刻失效</strong>，
      上面那条会换成新的。手机日历里需要重新添加一次订阅。
      只影响你自己，不会影响别人。
    </p>`,
  })}
</div>
</section>

<!-- ============ 外观 ============ -->
<section id="appearance" class="anchor-section">
${card({
    title: '外观',
    body: `
    ${/* 这个分组是补一个漏洞：深浅色开关原来只在侧栏底部，
         而手机上侧栏是 display:none —— 也就是手机上**根本没地方切**，
         只能跟着手机系统走。而且原来那个是「切换」不是「选择」，
         点过一次就固定在深或浅，再也回不到「跟随系统」。
         这里给三个明确选项，两个问题一起解决。 */ ''}
    <div class="filter-tabs" role="group" aria-label="界面配色">
      <button type="button" class="filter-tab" data-theme-choice="system">跟随系统</button>
      <button type="button" class="filter-tab" data-theme-choice="light">浅色</button>
      <button type="button" class="filter-tab" data-theme-choice="dark">深色</button>
    </div>
    <p class="field__help">
      「跟随系统」就是跟着手机/电脑的深色模式走（手机上：设置 → 显示与亮度）。
      选浅色或深色会固定下来，不随系统变。
    </p>
    <p class="field__help">
      这个选择只存在<strong>当前这台设备</strong>的浏览器里，换台设备要重新选一次；
      也不会同步到你的账号（所以它不占上面那个「保存设置」按钮）。
    </p>`,
  })}
</section>

<!-- ============ 个人偏好 ============ -->
<section id="prefs" class="anchor-section">
${card({
    title: '个人偏好',
    body: `<form class="form" data-settings-form>
    <div class="form__row">
      ${SETTING_DEFS.filter((d) => d.type !== 'periods' && !d.key.startsWith('daily_digest_channels')).map((def) => renderSettingField(def, settings[def.key])).join('')}
    </div>
    <div class="form__actions">
      <button type="submit" class="btn btn--primary">保存设置</button>
    </div>
  </form>`,
  })}
</section>

<!-- ============ 系统 ============ -->
<section id="system" class="anchor-section">
<div class="grid grid--2">
  ${card({
    title: '文件预览能力',
    body: `
    <div class="status-row">
      <div class="status-item">
        <span class="status-dot ${converter.available && officeConvertEnabled ? 'is-on' : 'is-off'}"></span>
        <div>
          <strong>${escapeHtml(converter.label)}</strong>
          <p class="muted small">${escapeHtml(converter.available && !officeConvertEnabled
        // 转换器装了、但自动转换被关掉了 —— 这时候不能照抄 converter.message，
        // 它会说「会自动转成 PDF」，而下面那行又写着「已关闭」，自相矛盾。
        ? '服务器上关掉了自动转换，PPT / Word 会以文字版显示。'
        : converter.message)}</p>
        </div>
      </div>
    </div>
    <dl class="kv">
      <dt>Office 转 PDF</dt><dd>${officeConvertEnabled ? badge('已开启', 'success') : badge('已关闭', 'neutral')}</dd>
      <dt>可预览格式</dt><dd class="small">PDF、PPT/PPTX、Word、Excel、图片、音视频、纯文本</dd>
    </dl>
    <p class="field__help">
      PPT / Word 会按原件排版显示；转换器不可用时会退化成网页版（能看文字，排版和图片会丢）。
      点开一份课件就能看到它实际用的哪种方式。
    </p>`,
  })}

  ${card({
    title: '存储占用',
    body: `
    <dl class="kv">
      <dt>课件与资料</dt><dd>${escapeHtml(storage.materialsLabel)}</dd>
      <dt>预览缓存</dt><dd>${escapeHtml(storage.cacheLabel)}</dd>
      <dt>数据库</dt><dd>${escapeHtml(storage.dbLabel)}</dd>
    </dl>
    <p class="field__help">
      预览缓存是课件转出来给浏览器看的中间文件，删掉也不影响原文件，下次打开会重新生成。
    </p>`,
  })}
</div>

${card({
    title: '账号',
    body: `<dl class="kv mb-md">
      <dt>用户名</dt><dd><code>${escapeHtml(user?.username || '')}</code></dd>
      ${user?.display_name ? `<dt>称呼</dt><dd>${escapeHtml(user.display_name)}</dd>` : ''}
      ${user?.school ? `<dt>学校</dt><dd>${escapeHtml(user.school)}</dd>` : ''}
      ${user?.created_at ? `<dt>注册于</dt><dd>${escapeHtml(String(user.created_at).slice(0, 10))}</dd>` : ''}
    </dl>
    <p class="field__help mb-md">
      这里是你自己的账号。你的课表、作业、课件和提醒都只存在这个账号下，
      别人注册了账号也看不到 —— 同一个站点上每个人的数据是分开的。
      用户名不能和别人的重复（大写小写算同一个），所以别忘了它。
    </p>
  <form class="form" data-password-form>
    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="pw_old">当前密码</label>
        <input id="pw_old" class="input" type="password" name="currentPassword" autocomplete="current-password" required>
      </div>
      <div class="field field--grow">
        <label class="field__label" for="pw_new">新密码</label>
        <input id="pw_new" class="input" type="password" name="newPassword" autocomplete="new-password"
               minlength="${PASSWORD_MIN_LENGTH}" required aria-describedby="pw_new_help">
        <p class="field__help" id="pw_new_help">至少 ${PASSWORD_MIN_LENGTH} 位。改成更长的句子更好记也更难猜。</p>
      </div>
      <div class="field field--grow">
        <label class="field__label" for="pw_new2">确认新密码</label>
        <input id="pw_new2" class="input" type="password" name="confirmPassword" autocomplete="new-password" required>
      </div>
    </div>
    <div class="form__actions">
      <button type="submit" class="btn btn--primary">修改密码</button>
    </div>
    <p class="field__help">
      改密码会顺手做两件事：<strong>把其他设备上的登录踢掉</strong>，
      并且<strong>作废已经发出去的日历订阅链接</strong>（那个链接不用登录就能看课表）。
      当前这台设备不受影响。
    </p>
  </form>

  <div class="subsection">
    <h4 class="subsection__title">登录状态</h4>
    <p class="field__help mb-sm">
      在图书馆、机房、同学电脑上登录过又忘了退，用这个把它们全部踢下线。
      你自己现在这台设备会保持登录。
    </p>
    <button type="button" class="btn btn--outline btn--sm" data-revoke-sessions>
      ${icon('logout', 16)}<span>退出其他所有设备</span>
    </button>
  </div>

  <div class="account-footer">
    <form class="logout-form" method="post" action="/logout">
      <button type="submit" class="btn btn--outline">${icon('logout', 16)} 退出登录</button>
    </form>
    <button type="button" class="btn btn--danger-ghost" data-open-delete-account>
      ${icon('trash', 16)}<span>注销账号</span>
    </button>
  </div>`,
  })}
</section>

<!-- 表单模板 -->
<template id="term-form-template">
  <form class="form" data-term-form>
    <div class="field">
      <label class="field__label" for="tf_name">学期名称<span class="field__req">*</span></label>
      <input id="tf_name" class="input" name="name" required placeholder="例如：2025-2026学年第一学期">
    </div>
    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="tf_start">第一周周一<span class="field__req">*</span></label>
        <input id="tf_start" class="input" type="date" name="startDate" required>
        <p class="field__help">校历上「第 1 教学周」的周一日期。</p>
      </div>
      <div class="field field--narrow">
        <label class="field__label" for="tf_weeks">总周数</label>
        <input id="tf_weeks" class="input" type="number" name="weekCount" min="1" max="30" value="18">
      </div>
    </div>
    <label class="check">
      <input type="checkbox" name="isActive" checked>
      <span>设为当前学期</span>
    </label>
    <div class="form__actions">
      <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
      <button type="submit" class="btn btn--primary">保存</button>
    </div>
  </form>
</template>

<template id="channel-form-template">
  <form class="form" data-channel-form>
    <input type="hidden" name="id">
    <div class="field">
      <label class="field__label" for="cf_type">推送方式<span class="field__req">*</span></label>
      <select id="cf_type" class="input" name="type" data-channel-type>
        ${CHANNELS.map((c) => `<option value="${c.type}">${escapeHtml(c.label)} —— ${escapeHtml(c.badge || '')}</option>`).join('')}
      </select>
      <p class="field__help" data-channel-tagline></p>
    </div>
    <div data-channel-guide></div>
    <div class="channel-fields" data-channel-fields></div>
    <div class="field">
      <label class="field__label" for="cf_name">备注名称</label>
      <input id="cf_name" class="input" name="name" placeholder="留空则用推送方式的名字">
    </div>
    <div class="form__row">
      <label class="check"><input type="checkbox" name="enabled" checked><span>启用</span></label>
      <label class="check"><input type="checkbox" name="isDefault"><span>设为默认渠道</span></label>
    </div>
    <div class="form__actions">
      <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
      <button type="button" class="btn btn--outline" data-test-channel>${icon('bell', 15)}<span>发送测试</span></button>
      <button type="submit" class="btn btn--primary">保存</button>
    </div>
  </form>
</template>

<!-- 注销账号。做成弹窗而不是常驻表单：它是一个不可逆的操作，
     嵌在页面里既占地方又容易被顺手点到。 -->
<template id="delete-account-form-template">
  <form class="form" data-delete-account-form>
    <div class="notice notice--error notice--compact">
      <div class="notice__icon">${icon('alert', 16)}</div>
      <div class="notice__body">
        这一步<strong>不可撤销、没有回收站</strong>。点下去之后，
        你的课表、作业、课件、提醒和推送记录都会被永久删除，无法恢复。
      </div>
    </div>
    <p class="field__help mb-md">
      如果你想留一份课件，建议先把要保留的文件下载下来 —— 删掉之后就没有了。
    </p>
    <div class="field">
      <label class="field__label" for="da_pass">你的密码</label>
      <input id="da_pass" class="input" type="password" name="password"
             autocomplete="current-password" required>
    </div>
    <div class="field">
      <label class="field__label" for="da_name">
        再输入一遍用户名 <code>${escapeHtml(user?.username || '')}</code> 以确认
      </label>
      <input id="da_name" class="input" name="confirmUsername" autocomplete="off"
             placeholder="原样照抄上面的用户名" required>
    </div>
    <div class="form__actions">
      <button type="button" class="btn btn--ghost" data-modal-close>取消</button>
      <button type="submit" class="btn btn--danger">${icon('trash', 15)}<span>永久删除我的账号</span></button>
    </div>
  </form>
</template>
`;

  return { title: '设置', active: 'settings', body };
}

function channelRow(c) {
  const def = CHANNELS.find((d) => d.type === c.type);
  const label = c.name || def?.label || c.type;

  // 展示时把敏感值打码
  const summary = Object.entries(c.config || {})
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .slice(0, 3)
    .map(([k, v]) => {
      const f = def?.fields?.find((fd) => fd.key === k);
      const shown = /pass|token|key|secret/i.test(k) && String(v).length > 6
        ? `${String(v).slice(0, 3)}••••`
        : String(v);
      return `<span class="config-chip" title="${escapeHtml(String(k))}">${escapeHtml(f?.label || k)}: ${escapeHtml(shown)}</span>`;
    }).join('');

  return `<div class="channel-row${c.enabled ? '' : ' is-disabled'}">
  <div class="channel-row__main">
    <div class="channel-row__head">
      <strong>${escapeHtml(label)}</strong>
      ${c.is_default ? badge('默认', 'primary') : ''}
      ${c.enabled ? '' : badge('已停用', 'neutral')}
    </div>
    <div class="channel-row__config">${summary || '<span class="muted small">未配置</span>'}</div>
  </div>
  <div class="channel-row__actions">
    <button type="button" class="btn btn--ghost btn--sm" data-test-channel-id="${c.id}">${icon('bell', 15)}<span>测试</span></button>
    <button type="button" class="btn btn--ghost btn--sm btn--icon" data-edit-channel="${c.id}" title="编辑">${icon('edit', 15)}</button>
    <button type="button" class="btn btn--ghost btn--sm btn--icon" data-delete-channel="${c.id}" data-name="${escapeHtml(label)}" title="删除">${icon('trash', 15)}</button>
  </div>
</div>`;
}

/** 把设置定义渲染成表单控件 */
function renderSettingField(def, value) {
  const current = value ?? def.default ?? '';

  if (def.type === 'switch') {
    return `<div class="field">
      <label class="check check--switch">
        <input type="checkbox" name="${def.key}" ${current === '1' || current === 'true' ? 'checked' : ''}>
        <span>${escapeHtml(def.label)}</span>
      </label>
      <p class="field__help">${escapeHtml(def.help || '')}</p>
    </div>`;
  }

  return `<div class="field field--grow">
    <label class="field__label" for="set_${def.key}">${escapeHtml(def.label)}</label>
    <input id="set_${def.key}" class="input" type="${def.type === 'time' ? 'time' : 'text'}" name="${def.key}" value="${escapeHtml(String(current))}">
    <p class="field__help">${escapeHtml(def.help || '')}</p>
  </div>`;
}

// ============================================================
// 登录 / 注册
// ============================================================

/**
 * 登录与注册页。
 *
 * 从「单用户自用」改成「多用户」时，这个页面从**二选一**变成了**双 Tab**：
 *   以前：没有账号 → 显示初始化表单；有账号 → 显示登录表单。永远只看到一个。
 *   现在：两个 Tab 同时在，用户可以自己选。
 *
 * Tab 用「隐藏的 radio + :checked」实现，**不依赖 JavaScript**：
 *   两个 radio 排在前面，后面的标签和面板用 ~ 兄弟选择器跟着切换。
 *   好处是即使 JS 挂了、或者用户禁用了 JS，注册和登录照样能用 ——
 *   这是这个页面唯一的功能，不能有闪失。
 *
 * @param {object} opts
 * @param {'login'|'register'} [opts.mode] 默认展开哪个 Tab
 * @param {string} [opts.error] 出错信息（显示在当前 Tab 里）
 * @param {string} [opts.username] 回填的用户名
 * @param {boolean} [opts.inviteRequired] 是否要求邀请码
 * @param {boolean} [opts.registerOpen] 是否允许注册。false 时注册 Tab
 *   变成长说明（而不是把表单藏起来）—— 让人知道这里本来有个注册入口、
 *   以及该找谁，比给一个空白页面有用得多。
 * @param {string} [opts.info] 提示信息（绿色以外的中性提示，例如「账号已注销」）
 */
export function loginPage({
  mode = 'login',
  error = '',
  info = '',
  username = '',
  inviteRequired = false,
  registerOpen = true,
} = {}) {
  /**
   * 一条提示。
   * @param {string} text 内容
   * @param {'error'|'info'} kind 语气
   * @param {string} iconName 图标名
   */
  const notice = (text, kind = 'error', iconName = 'alert') => (text
    ? `<div class="notice notice--${kind} notice--compact">
        <div class="notice__icon">${icon(iconName, 16)}</div>
        <div class="notice__body">${escapeHtml(text)}</div>
      </div>`
    : '');

  // 提示只显示在相关的那个 Tab 里，免得两个表单下面都挂着一条不相干的横幅
  const loginError = mode === 'login' ? notice(error) + notice(info, 'info', 'check') : '';
  const registerError = mode === 'register' ? notice(error) : '';

  return {
    title: mode === 'register' ? '注册' : '登录',
    active: '',
    // 还没进站，不该套站内导航：未登录时侧边栏那 6 个入口和手机底部导航
    // 点了只会被弹回这一页，底栏还会挡住表单。理由写在 layout.js 的 bare 说明里。
    bare: true,
    body: `
<div class="auth-shell">
  <div class="auth-card">
    <div class="auth-brand">
      <span class="brand__mark">${icon('book', 24)}</span>
      <h1 class="auth-title">学习守护</h1>
      <p class="auth-sub">课程表 · 课件预览 · 作业 DDL 提醒</p>
    </div>

    <div class="auth-tabs">
      <input type="radio" id="tab-login" name="auth-tab" class="auth-tabs__radio"
             ${mode === 'register' ? '' : 'checked'}>
      <input type="radio" id="tab-register" name="auth-tab" class="auth-tabs__radio"
             ${mode === 'register' ? 'checked' : ''}>

      <div class="auth-tabs__bar" role="tablist">
        <label for="tab-login" class="auth-tabs__tab">登录</label>
        <label for="tab-register" class="auth-tabs__tab">注册</label>
      </div>

      <!-- ================= 登录 ================= -->
      <div class="auth-tabs__panel" data-panel="login">
        ${loginError}
        <form class="form" method="post" action="/login">
          <div class="field">
            <label class="field__label" for="lg_user">用户名</label>
            <input id="lg_user" class="input" name="username" required
                   value="${escapeHtml(username)}" autocomplete="username">
          </div>
          <div class="field">
            <label class="field__label" for="lg_pass">密码</label>
            <input id="lg_pass" class="input" type="password" name="password" required
                   autocomplete="current-password">
          </div>
          <button type="submit" class="btn btn--primary btn--block">登录</button>
        </form>
        <p class="auth-foot muted small">
          忘记密码？这个站点没有自助找回，<strong>找站点管理员帮你重置</strong>即可（数据不受影响）。
        </p>
      </div>

      <!-- ================= 注册 ================= -->
      <div class="auth-tabs__panel" data-panel="register">
        ${registerOpen ? `
        ${registerError}
        <form class="form" method="post" action="/register">
          <div class="field">
            <label class="field__label" for="rg_user">用户名</label>
            <input id="rg_user" class="input" name="username" required maxlength="50"
                   value="${escapeHtml(mode === 'register' ? username : '')}"
                   autocomplete="username" placeholder="登录时用，不能和别人重复">
          </div>
          <div class="field">
            <label class="field__label" for="rg_pass">密码</label>
            <input id="rg_pass" class="input" type="password" name="password" required
                   minlength="${PASSWORD_MIN_LENGTH}" autocomplete="new-password"
                   aria-describedby="rg_pass_help">
            <p class="field__help" id="rg_pass_help">
              至少 ${PASSWORD_MIN_LENGTH} 位，长一点更好。
              这台服务器只有密码这一道防线，<strong>别用生日、学号或纯数字</strong>。
            </p>
          </div>
          <div class="field">
            <label class="field__label" for="rg_pass2">确认密码</label>
            <input id="rg_pass2" class="input" type="password" name="password2" required
                   autocomplete="new-password">
          </div>
          <div class="field">
            <label class="field__label" for="rg_name">怎么称呼你（选填）</label>
            <input id="rg_name" class="input" name="displayName" placeholder="例如：小王">
          </div>
          <div class="field">
            <label class="field__label" for="rg_school">学校（选填）</label>
            <input id="rg_school" class="input" name="school" placeholder="例如：东北财经大学">
          </div>
          ${inviteRequired ? `
          <div class="field">
            <label class="field__label" for="rg_invite">邀请码 <span class="field__req">*</span></label>
            <input id="rg_invite" class="input" name="inviteCode" required
                   autocomplete="off" placeholder="向站点管理员索取">
          </div>` : ''}
          <button type="submit" class="btn btn--primary btn--block">创建账号</button>
        </form>
        <p class="auth-foot muted small">
          你的课表、作业、课件保存在<strong>本站服务器</strong>上，只有登录你自己的账号才看得到。
        </p>` : `
        <div class="notice notice--compact">
          <div class="notice__icon">${icon('lock', 16)}</div>
          <div class="notice__body">
            本站暂未开放自助注册。<br>
            想开通账号，请联系站点管理员。
          </div>
        </div>
        <p class="auth-foot muted small">
          已经有账号了？切到<strong>登录</strong>那一栏就行。
        </p>`}
      </div>
    </div>
  </div>
</div>`,
  };
}
