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

/** 社区首页 */
export function communityPage({
  user, school, schoolVerified, feed = [], alumni = [], myPublished = 0, mySchool = '',
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

${feed.length === 0
      ? emptyState({
        level: 2,
        icon: 'folder',
        title: '同校同学还没公开什么资料',
        description: '等同学把课件公开出来，这里就会有了。你也可以先在「我的资料」里挑几份公开。',
        action: `<a class="btn btn--primary" href="/materials">${icon('folder', 16)}<span>去我的资料</span></a>`,
      })
      : `<section class="community-grid">
        ${feed.map((item) => feedCard(item)).join('')}
      </section>`}

${alumni.length ? `
${card({
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
      <p class="field__help">
        只有<strong>公开过资料</strong>的同学会出现在这里 —— 这份名单不是全校名册。
      </p>`,
    })}` : ''}
`}
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
