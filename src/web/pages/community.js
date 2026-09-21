/**
 * 校友社区。
 *
 * 两条页面：
 *   · /community        —— 同校同学公开出来的资料
 *   · /community/:id    —— 某个校友的公开资料
 *
 * 这里是**唯一**一个能看到别人数据的板块，所以有两条纪律：
 *
 * 1. **不显示登录用户名。** 社区里认人靠昵称 + 头像 + 学院专业。
 *    用户名是登录凭据，同校陌生人拿到就等于把「试密码」的起点送出去。
 *    这不是"顺手少写一个字段"，而是用户明确拍板的前提。
 *
 * 2. **校名对不上名单就不显示任何内容**，而不是报错。
 *    老账号的学校是手填的，对不上很正常；那时候应该看到一句解释
 *    （"你的学校还没从名单里选过"），而不是一个 500 或者一片空白。
 */

import { escapeHtml } from '../../lib/http.js';
import { icon, pageHeader, card, emptyState } from '../layout.js';

/**
 * 列表底部那行「共 N 份，这里显示最近 M 份 + 再看更多」。
 *
 * 为什么必须有：查询是 `ORDER BY updated_at DESC LIMIT 40`，**没有 offset**。
 * 换成大白话就是「同校公开的资料攒到 40 份以上之后，更早的那批就永远看不见了」——
 * 而页面上原本没有任何迹象表明"还有更多"。用户会以为看到的就是全部。
 *
 * 「再看更多」做成**链接**（`?show=80`）而不是 JS 按钮：服务端渲染的页面
 * 没有 JS 也能用，而且能直接分享/收藏某一个深度，不用维护前端状态。
 *
 * @param {number} shown  这一屏显示了几条
 * @param {number} total  一共有多少条（和列表用同一组可见性条件算出来的）
 */
function moreRow(shown, total, unit, show, base) {
  if (!(total > shown)) return '';
  const next = Math.min(show + 40, 200);
  // 已经加到上限了就不再给链接 —— 给一个点了没变化的按钮比不给更糟
  const more = next > show
    ? `<a class="btn btn--outline btn--sm" href="${base}?show=${next}">
        ${icon('chevronDown', 15)}<span>再看 ${next - show} ${unit}</span>
      </a>`
    : '';
  return `<div class="more-row" data-more-row>
    <span class="muted small">共 ${total} ${unit}，这里显示最近 ${shown} 个。</span>
    ${more}
  </div>`;
}

/** 头像：有图显示图，没有就显示昵称首字母 —— 和侧栏那个圆圈一套逻辑 */
function avatarHtml(person, size = 40) {
  const letter = escapeHtml((person.displayName || '?').slice(0, 1));
  if (!person.hasAvatar) {
    return `<span class="alumni-avatar" style="width:${size}px;height:${size}px">${letter}</span>`;
  }
  return `<img class="alumni-avatar" src="/avatar/${Number(person.id)}" alt=""
     style="width:${size}px;height:${size}px" loading="lazy">`;
}

/** 「统计学院 · 统计学」，两个都没有就返回空串 */
function collegeLine(person) {
  return [person.college, person.major].filter(Boolean).join(' · ');
}

/**
 * 学校还没从名单里选过时，社区是空的 —— 说清楚为什么，并给出出路。
 * 这一条对老账号很关键：他们不会想到"学校对不上名单就看不到社区"。
 */
function needsSchoolCard({ school, schoolVerified }) {
  const reason = !school
    ? '你还没填学校。'
    : `你现在填的是「${escapeHtml(school)}」，它不在学校名单里。`;
  return card({
    title: '还进不了校友社区',
    body: `
    <p>${reason}社区是<strong>按学校分</strong>的 —— 只有校名能对上名单里的某一所，
      才能找到同学、也才能让同学找到你。</p>
    <p class="field__help">
      去<a href="/settings#system">设置 → 账号 → 个人资料</a>里，
      从下拉候选里挑一个保存一下就好。${schoolVerified ? '' : '（手填的校名不算 —— 那样谁都可以自称是某校的。）'}
    </p>
    <p class="field__help">
      顺便说一句：社区里只会显示你的<strong>昵称、头像、学院和专业</strong>，
      登录用户名不会给任何人看。
    </p>`,
  });
}

/**
 * 「我公开的」那一栏。
 *
 * 公开放出去的资料对**自己**是有意义的：别人能不能看到、看到了什么，
 * 你总得先能看见自己那份长什么样。而社区列表按设计只显示别人的东西，
 * 所以公开完之后这一页看起来毫无变化 —— 这一栏就是把那个回显补上。
 *
 * 它和学校无关：学校还没从名单里选过的人也该看得见自己公开了什么，
 * 所以它**不放在** `schoolVerified` 那个分支里。
 *
 * ⚠️ 但「和学校无关」不等于「可以说同校同学看得到」：
 *    校名没从名单里选过时，sameSchool 直接返回 false，这 N 份**谁也看不到**。
 *    第一版这里写死了「同校同学现在能看到、也能下载这几份」——
 *    在学校未验证的分支上那是**假话**，而且同一页上面还写着「还进不了校友社区」，
 *    自相矛盾。所以下面按 schoolVerified 分两套说法。
 */
function myPublishedSection(materials, total, schoolVerified) {
  // 标题上的数字用**真实总数**，不是列表长度 —— 列表最多列 20 份，
  // 只公开了 3 份的人看到的必须是 3，公开了 30 份的人也不该看到 "20"
  // 却不知道还有 10 份没列出来。
  const count = Number(total) || 0;
  const truncated = materials.length < count;
  return `<section class="community-section" data-my-published>
${card({
    title: `我公开的（${count}）`,
    body: materials.length === 0
      ? `<p class="small">你还没有公开任何资料。在<a href="/materials">我的资料</a>里编辑任意一份，
           勾上「公开给同校同学」，它就会出现在这里；资料多的可以用列表底部那条
           <strong>批量公开</strong>一次搞定。</p>
         ${schoolVerified
      ? `<p class="field__help">
           公开出去的范围是<strong>同校同学</strong> —— 他们可以看，也可以下载。
           没公开的东西只有你自己看得见，别人连「存在」都问不出来。
         </p>`
      : `<p class="field__help field__help--warn">
           不过你的学校还没<strong>从名单里选过</strong>，所以现在就算公开，
           同学那边也看不到 —— 先去<a href="/settings#system">设置 → 个人资料</a>里选一所学校。
         </p>`}`
      : `<ul class="material-list">
        ${materials.map((m) => `
          <li class="material-row">
            <a class="material-row__link" href="/materials/${Number(m.id)}">
              <span class="material-row__icon">${icon(m.hasPdf ? 'fileText' : 'file', 20)}</span>
              <span class="material-row__body">
                <span class="material-row__title">${escapeHtml(m.title)}</span>
                <span class="material-row__meta">
                  ${escapeHtml(String(m.updatedAt || '').slice(0, 10))}
                  <span class="material-row__meta-extra"> · ${escapeHtml(m.category || '')}</span>
                </span>
              </span>
            </a>
          </li>`).join('')}
      </ul>
      ${truncated ? `<p class="field__help">
        这里只列了最近 ${materials.length} 份，全部在<a href="/materials">我的资料</a>里。
      </p>` : ''}
      ${schoolVerified
      ? `<p class="field__help">
        同校同学现在能看到、也能下载这几份。想收回就在<a href="/materials">我的资料</a>里
        取消勾选（或用底部的<strong>批量公开</strong>一次收回）。
      </p>`
      : `<p class="field__help field__help--warn" data-my-published-invisible>
        ⚠️ 这 ${count} 份现在<strong>谁也看不到</strong> —— 你的学校还没
        <strong>从名单里选过</strong>。社区是按学校分的，校名对不上名单就没有"同校"可言，
        所以同学那边一份都看不到。
      </p>
      <p class="field__help">
        去<a href="/settings#system">设置 → 个人资料</a>里选一所学校保存，
        这几份会<strong>立刻对同校同学可见</strong>，不用回来重勾。
        想收回就在<a href="/materials">我的资料</a>里取消勾选。
      </p>`}`,
  })}
</section>`;
}

/** 社区首页 */
export function communityPage({
  user, school, schoolVerified, feed = [], feedTotal = 0,
  alumni = [], alumniTotal = 0,
  myPublished = 0, mySchool = '', myMaterials = [], show = 40,
}) {
  const body = `
${pageHeader({
    title: '校友社区',
    subtitle: mySchool
      ? `${escapeHtml(mySchool)} · 同校同学公开出来的资料`
      : '同校同学公开出来的资料',
    actions: `<a class="btn btn--outline btn--sm" href="/materials">${icon('folder', 15)}<span>我的资料</span></a>`,
  })}

${!schoolVerified ? needsSchoolCard({ school, schoolVerified }) : `
<div class="notice notice--compact">
  <div class="notice__icon">${icon('users', 16)}</div>
  <div class="notice__body">
    <p>
      这里只显示<strong>同校同学主动公开</strong>的资料。别人没勾「公开给同校」的东西，
      你在这里看不到 —— 反过来也一样。你自己的资料公开了 ${myPublished} 份。
    </p>
    <p class="small">
      ${/* 这条要放在**列表页**上，不能只放在校友页里 ——
           用户是在这里第一次看到别人的，得先知道对方看不到自己的用户名 */ ''}
      社区里只显示昵称、头像、学院和专业。<strong>登录用户名不会显示给任何人</strong>。
    </p>
  </div>
</div>

<section class="community-section" data-shared-feed>
${feed.length === 0
      ? emptyState({
        level: 2,
        icon: 'folder',
        title: '同校同学还没公开什么资料',
        description: '等同学把课件公开出来，这里就会有了。你也可以先在「我的资料」里挑几份公开。',
        action: `<a class="btn btn--primary" href="/materials">${icon('folder', 16)}<span>去我的资料</span></a>`,
      })
      : `<div class="community-grid">
        ${feed.map((item) => feedCard(item)).join('')}
      </div>
      ${moreRow(feed.length, feedTotal, '份公开的资料', show, '/community')}`}
</section>
`}

${/* 放在学校判断**外面**：自己公开了什么，和有没有从名单选过学校无关 */ ''}
${myPublishedSection(myMaterials, myPublished, schoolVerified)}

${schoolVerified && alumni.length ? card({
      title: '同校校友',
      body: `<div class="alumni-row">
        ${alumni.map((a) => `
          <a class="alumni-chip" href="/community/${Number(a.id)}">
            ${avatarHtml(a, 34)}
            <span class="alumni-chip__body">
              <span class="alumni-chip__name">${escapeHtml(a.displayName || '（没填昵称）')}</span>
              <span class="alumni-chip__meta">${escapeHtml(collegeLine(a) || '没填学院专业')}
                · 公开了 ${Number(a.sharedCount)} 份</span>
            </span>
          </a>`).join('')}
      </div>
      ${moreRow(alumni.length, alumniTotal, '位校友', show, '/community')}
      <p class="field__help">
        只有<strong>公开过资料</strong>的同学会出现在这里 —— 这份名单不是全校名册。
      </p>`,
    }) : ''}
`;

  return { title: '校友社区', active: 'community', body };
}

/** 一份公开资料的卡片 */
function feedCard(item) {
  const o = item.owner;
  return `<article class="community-card">
  <header class="community-card__head">
    ${avatarHtml(o, 38)}
    <div class="community-card__who">
      <a class="community-card__name" href="/community/${Number(o.id)}">${escapeHtml(o.displayName || '（没填昵称）')}</a>
      <span class="community-card__meta">${escapeHtml(collegeLine(o) || '没填学院专业')}</span>
    </div>
  </header>
  <a class="community-card__body" href="/materials/${Number(item.id)}">
    <span class="community-card__title">${escapeHtml(item.title)}</span>
    <span class="community-card__info">
      ${item.course
      ? `<span class="dot" style="--dot-color:${escapeHtml(item.course.color || '#3a63e8')}"></span>${escapeHtml(item.course.name)} · `
      : ''}${escapeHtml(item.updatedAt ? String(item.updatedAt).slice(0, 10) : '')}
    </span>
  </a>
</article>`;
}

/** 某个校友的页面 */
export function alumniPage({
  user, person, materials = [], isSelf = false,
}) {
  const body = `
${pageHeader({
    title: person.displayName || '（没填昵称）',
    subtitle: collegeLine(person) || '没填学院专业',
    breadcrumb: `<a href="/community">校友社区</a> ${icon('chevronRight', 12)} ${escapeHtml(person.displayName || '同学')}`,
    actions: `<a class="btn btn--outline btn--sm" href="/community">${icon('chevronLeft', 15)}<span>回社区</span></a>`,
  })}

${card({
    title: '这个人',
    body: `<div class="alumni-profile">
      ${avatarHtml(person, 64)}
      <div>
        <div class="alumni-profile__name">${escapeHtml(person.displayName || '（没填昵称）')}</div>
        <dl class="kv">
          <dt>学校</dt><dd>${escapeHtml(person.school || '')}</dd>
          ${person.college ? `<dt>学院</dt><dd>${escapeHtml(person.college)}</dd>` : ''}
          ${person.major ? `<dt>专业</dt><dd>${escapeHtml(person.major)}</dd>` : ''}
        </dl>
      </div>
    </div>
    <p class="field__help">
      ${/* 明确写出「没有显示用户名」这件事，让用户放心 —— 
           也提醒以后改这个页面的人别顺手加回去 */ ''}
      社区里只显示昵称、头像、学院和专业。<strong>登录用户名不会显示给任何人</strong>。
    </p>`,
  })}

${materials.length === 0
      ? emptyState({
        level: 2,
        icon: 'folder',
        title: isSelf ? '你还没公开任何资料' : '这位同学还没公开资料',
        description: '在「我的资料」里编辑任意一份，勾上「公开给同校同学」就会出现在这里。',
      })
      : card({
        title: `公开的资料（${materials.length}）`,
        body: `<ul class="material-list">
          ${materials.map((m) => `
            <li class="material-row">
              <a class="material-row__link" href="/materials/${Number(m.id)}">
                <span class="material-row__icon">${icon(m.hasPdf ? 'fileText' : 'file', 20)}</span>
                <span class="material-row__body">
                  <span class="material-row__title">${escapeHtml(m.title)}</span>
                  <span class="material-row__meta">
                    ${escapeHtml(String(m.updatedAt || '').slice(0, 10))}
                    <span class="material-row__meta-extra"> · ${escapeHtml(m.category || '')}</span>
                  </span>
                </span>
              </a>
            </li>`).join('')}
        </ul>`,
      })}
`;

  return { title: person.displayName || '校友', active: 'community', body };
}
