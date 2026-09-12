/**
 * 设置页。
 *
 * 分成五块：
 *   1. 学期 —— 周次计算的基础
 *   2. 手机提醒 —— Bark / 邮件 / 企业微信等渠道的配置与测试
 *   3. 提醒调度 —— 调度器状态、日志
 *   4. 课表导入导出 —— ICS / CSV
 *   5. 系统 —— 转换器状态、存储占用、修改密码
 */

import { escapeHtml } from '../../lib/http.js';
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
  appInfo,
  periodSchedule = [],
  defaultPeriodSchedule = [],
  hasCustomPeriods = false,
}) {
  const body = `
${pageHeader({
    title: '设置',
    subtitle: '学期、作息时间、手机提醒、课表导入导出与系统信息',
  })}

<nav class="anchor-nav" aria-label="设置分区">
  <a href="#term">学期</a>
  <a href="#periods">作息时间</a>
  <a href="#notify">手机提醒</a>
  <a href="#schedule">提醒调度</a>
  <a href="#calendar">课表导入导出</a>
  <a href="#prefs">个人偏好</a>
  <a href="#system">系统</a>
</nav>

<!-- ============ 学期 ============ -->
<section id="term">
${card({
    title: '学期',
    actions: `<button type="button" class="btn btn--outline btn--sm" data-new-term>${icon('plus', 15)}<span>新增学期</span></button>`,
    body: terms.length
      ? `<table class="table">
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
    <p class="field__help">
      「第一周周一」是课表周次计算的基准，**必须是星期一**。教务处的校历上会写「第 1 教学周」，那就是它。
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
        ${periodSchedule.map((p) => `
          <div class="period-row" data-period-row>
            <div class="period-row__index">
              第 <input class="input input--period-index" type="number" min="1" max="30" name="p_index"
                        value="${escapeHtml(String(p.index))}" aria-label="节次"> 节
            </div>
            <input class="input" type="time" name="p_start" value="${escapeHtml(p.start)}" aria-label="开始时间">
            <input class="input" type="time" name="p_end" value="${escapeHtml(p.end)}" aria-label="结束时间">
            <span class="period-row__len" data-period-len>${periodLengthLabel(p.start, p.end)}</span>
            <button type="button" class="btn btn--ghost btn--icon" data-remove-period title="删除这一节" aria-label="删除这一节">${icon('trash', 15)}</button>
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
    title: '提醒调度',
    body: `
  <div class="status-row">
    <div class="status-item">
      <span class="status-dot ${scheduler.running ? 'is-on' : 'is-off'}"></span>
      <div>
        <strong>调度器${scheduler.running ? '运行中' : '未运行'}</strong>
        <p class="muted small">每 ${scheduler.intervalSec} 秒检查一次待发提醒。${scheduler.lastTickAt ? `上次检查：${escapeHtml(scheduler.lastTickAt)}` : ''}</p>
      </div>
    </div>
    <button type="button" class="btn btn--outline btn--sm" data-run-scheduler>${icon('refresh', 15)}<span>立即检查一次</span></button>
  </div>

  <div class="notice notice--info notice--compact">
    <div class="notice__icon">${icon('alert', 16)}</div>
    <div class="notice__body">
      <strong>提醒依赖服务在运行</strong>
      <p class="small">
        调度器跟着本平台的服务进程跑。<strong>电脑关机 / 服务停止时，提醒不会发出。</strong>
        想让 DDL 提醒 100% 可靠，需要把服务放到一台常开的机器上——
        云服务器（学生机约 10 元/月）、树莓派，或者家里一直开着的旧电脑都行。
      </p>
    </div>
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
  </details>` : '<p class="muted small">还没有任何发送记录。配置好渠道后，可以点上面的「立即检查一次」或直接发测试消息。</p>'}`,
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
    </p>`,
  })}
</div>
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
        <span class="status-dot ${converter.available ? 'is-on' : 'is-off'}"></span>
        <div>
          <strong>${escapeHtml(converter.label)}</strong>
          <p class="muted small">${escapeHtml(converter.message)}</p>
        </div>
      </div>
    </div>
    <dl class="kv">
      <dt>Office 转 PDF</dt><dd>${officeConvertEnabled ? badge('已开启', 'success') : badge('已关闭', 'neutral')}</dd>
      <dt>可预览格式</dt><dd class="small">PDF、PPT/PPTX、Word、Excel、图片、音视频、纯文本</dd>
    </dl>
    <p class="field__help">
      装一个免费开源的 <a href="https://www.libreoffice.org/" target="_blank" rel="noopener">LibreOffice</a>
      就能让 PPT/Word 的预览效果和原件完全一致。也可以在你的电脑上关掉 WPS/Office 的自动更新，
      本平台会自动探测并调用它们。
    </p>`,
  })}

  ${card({
    title: '存储与系统',
    body: `
    <dl class="kv">
      <dt>资料占用</dt><dd>${escapeHtml(storage.materialsLabel)}</dd>
      <dt>转换缓存</dt><dd>${escapeHtml(storage.cacheLabel)}</dd>
      <dt>数据库</dt><dd>${escapeHtml(storage.dbLabel)}</dd>
      <dt>数据目录</dt><dd><code class="small">${escapeHtml(appInfo.dataDir)}</code></dd>
      <dt>服务地址</dt><dd><code class="small">${escapeHtml(appInfo.url)}</code></dd>
      <dt>版本</dt><dd>${escapeHtml(appInfo.version)}</dd>
      <dt>Node.js</dt><dd>${escapeHtml(appInfo.nodeVersion)}</dd>
    </dl>
    <div class="btn-row mt-sm">
      <a class="btn btn--outline btn--sm" href="#" data-open-path="${escapeHtml(appInfo.dataDir)}">${icon('folder', 15)}<span>打开数据目录</span></a>
    </div>
    <p class="field__help">
      所有数据都在 <code>data/</code> 目录里：数据库、上传的课件、转换缓存。
      备份就是复制这个目录，换电脑直接搬过去即可。
    </p>`,
  })}
</div>

${card({
    title: '账号',
    body: `<form class="form" data-password-form>
    <div class="form__row">
      <div class="field field--grow">
        <label class="field__label" for="pw_old">当前密码</label>
        <input id="pw_old" class="input" type="password" name="currentPassword" autocomplete="current-password" required>
      </div>
      <div class="field field--grow">
        <label class="field__label" for="pw_new">新密码</label>
        <input id="pw_new" class="input" type="password" name="newPassword" autocomplete="new-password" minlength="6" required>
        <p class="field__help">至少 6 位。</p>
      </div>
      <div class="field field--grow">
        <label class="field__label" for="pw_new2">确认新密码</label>
        <input id="pw_new2" class="input" type="password" name="confirmPassword" autocomplete="new-password" required>
      </div>
    </div>
    <div class="form__actions">
      <button type="submit" class="btn btn--primary">修改密码</button>
    </div>
  </form>`,
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
// 登录 / 初始化
// ============================================================

export function loginPage({ error = '', username = '', needsSetup = false }) {
  return {
    title: needsSetup ? '初始化' : '登录',
    active: '',
    body: `
<div class="auth-shell">
  <div class="auth-card">
    <div class="auth-brand">
      <span class="brand__mark">${icon('book', 24)}</span>
      <h1 class="auth-title">学习守护</h1>
      <p class="auth-sub">课程表 · 课件预览 · 作业 DDL 提醒</p>
    </div>

    ${error ? `<div class="notice notice--error notice--compact">
      <div class="notice__icon">${icon('alert', 16)}</div>
      <div class="notice__body">${escapeHtml(error)}</div>
    </div>` : ''}

    <form class="form" method="post" action="${needsSetup ? '/setup' : '/login'}">
      <div class="field">
        <label class="field__label" for="lg_user">用户名</label>
        <input id="lg_user" class="input" name="username" value="${escapeHtml(username)}" required
               autocomplete="username" autofocus ${needsSetup ? 'placeholder="给自己起个用户名"' : ''}>
      </div>
      <div class="field">
        <label class="field__label" for="lg_pass">密码</label>
        <input id="lg_pass" class="input" type="password" name="password" required
               autocomplete="${needsSetup ? 'new-password' : 'current-password'}"
               ${needsSetup ? 'placeholder="至少 6 位"' : ''}>
      </div>
      ${needsSetup ? `
      <div class="field">
        <label class="field__label" for="lg_pass2">确认密码</label>
        <input id="lg_pass2" class="input" type="password" name="password2" required autocomplete="new-password">
      </div>
      <div class="field">
        <label class="field__label" for="lg_name">怎么称呼你（选填）</label>
        <input id="lg_name" class="input" name="displayName" placeholder="例如：小王">
      </div>
      <div class="field">
        <label class="field__label" for="lg_school">学校（选填）</label>
        <input id="lg_school" class="input" name="school" value="东北财经大学">
      </div>
      <p class="field__help">
        账号只保存在你自己的电脑上（<code>data/app.db</code>），不会上传到任何地方。
        密码用 scrypt 加盐哈希存储。
      </p>` : ''}
      <button type="submit" class="btn btn--primary btn--block">${needsSetup ? '创建账号并开始使用' : '登录'}</button>
    </form>

    ${needsSetup ? '' : `<p class="auth-foot muted small">忘记密码？删掉 <code>data/app.db</code> 重新初始化即可（会丢失所有数据，建议先备份）。</p>`}
  </div>
</div>`,
  };
}
