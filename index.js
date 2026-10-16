'use strict';
// 디스코드 인증 봇 + 웹 패널 (버튼 / 이모지 / 캡챠 인증)
// 환경변수(Railway Variables): ADMIN_PASSWORD (필수), DATA_DIR (선택, 볼륨 경로 예: /data)
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
  ChannelType, MessageFlags,
} = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
// ═════════ 자충 / 상점 모듈 ═════════
const charge = (() => {
// 자충(자동충전) 자판기 모듈
// 흐름: 유저 충전 신청(입금자명+금액) → 입금 문자 웹훅이 오면 자동 매칭 → 잔액 충전
//       자동승인이 꺼져 있으면 웹 패널에서 관리자가 수동 승인
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ChannelType, MessageFlags,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');

const EPH = MessageFlags.Ephemeral;
const TYPES = { ios: 'iOS', android: '안드로이드' };
const DEF = {
  enabled: false, // 충전 기능 전체 on/off (꺼지면 신청/입금 처리 모두 동작 안 함)
  auto: true, // 입금 감지 시 자동 승인 (끄면 관리자 수동 승인)
  bank: '', number: '', holder: '',
  minAmount: 1000, maxAmount: 500000, expireMinutes: 30,
  channelId: '', logChannelId: '', messageId: '',
  shopChannelId: '', shopMessageId: '', buyLogChannelId: '', reviewChannelId: '',
  title: '💰 충전 자판기', desc: '아래 버튼으로 충전을 신청하세요.',
  key: '',
};

let ctx = null;
let dataFile = '';
let store = { balances: {}, requests: [], configs: {}, products: [], purchases: [] };

// ───────────── 저장소 ─────────────
function load() {
  try {
    store = { ...store, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('충전 데이터 로드 실패:', e.message);
  }
}

function save() {
  if (store.requests.length > 3000) store.requests = store.requests.slice(-3000);
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const tmp = dataFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, dataFile);
}

const fmt = (n) => Number(n).toLocaleString('ko-KR');
const cfgKey = (g, t) => `${g}:${t}`;
const getCfg = (g, t) => ({ ...DEF, ...(store.configs[cfgKey(g, t)] || {}) });
const setCfg = (g, t, c) => { store.configs[cfgKey(g, t)] = c; save(); };
const getBal = (g, u) => store.balances[`${g}:${u}`] || 0;
const addBal = (g, u, n) => { store.balances[`${g}:${u}`] = getBal(g, u) + n; };
const newKey = () => crypto.randomBytes(24).toString('hex');
const newId = () => crypto.randomBytes(4).toString('hex');

function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function expireOld() {
  const now = Date.now();
  let changed = false;
  for (const r of store.requests) {
    if (r.status !== 'pending') continue;
    if (r.createdAt + getCfg(r.guildId, r.type).expireMinutes * 60000 < now) {
      r.status = 'expired';
      changed = true;
    }
  }
  if (changed) save();
}

// ───────────── 충전 처리 / 알림 ─────────────
async function notify(r, via) {
  const client = ctx.getClient();
  if (!client) return;
  const cfg = getCfg(r.guildId, r.type);
  const label = { auto: '자동 승인', manual: '수동 승인', admin: '관리자' }[via] || via;
  const bal = getBal(r.guildId, r.userId);
  const dm = r.amount > 0
    ? `✅ ${fmt(r.amount)}원 충전이 완료되었습니다. (현재 잔액 ${fmt(bal)}원)`
    : `➖ ${fmt(-r.amount)}원이 차감되었습니다. (현재 잔액 ${fmt(bal)}원)`;
  client.users.fetch(r.userId).then((u) => u.send(dm)).catch(() => {});
  if (!cfg.logChannelId) return;
  const g = client.guilds.cache.get(r.guildId);
  const ch = g ? await g.channels.fetch(cfg.logChannelId).catch(() => null) : null;
  if (ch && ch.isTextBased()) {
    ch.send({
      content: `💰 [${TYPES[r.type]}] <@${r.userId}> ${r.amount > 0 ? '+' : ''}${fmt(r.amount)}원 (${label}) · 잔액 ${fmt(bal)}원`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

function finish(r, via) {
  if (r.status !== 'pending' && r.status !== 'expired') throw new Error('이미 처리된 요청입니다.');
  r.status = 'done';
  r.via = via;
  r.doneAt = Date.now();
  addBal(r.guildId, r.userId, r.amount);
  save();
  notify(r, via).catch(() => {});
}

// ───────────── 상점 (상품 구매 / 구매 로그 / 구매 후기) ─────────────
const prodsOf = (g, t) => store.products.filter((p) => p.guildId === g && p.type === t);

function buildShopPayload(gid, type) {
  const list = prodsOf(gid, type);
  const lines = list.length
    ? list.map((p) => `• **${p.name}** — ${fmt(p.price)}원 (재고 ${p.items.length})${p.desc ? `\n  ${p.desc}` : ''}`).join('\n')
    : '등록된 상품이 없습니다.';
  const embed = new EmbedBuilder().setTitle(`🛒 ${TYPES[type]} 자판기`).setDescription(lines.slice(0, 4000)).setColor('#57F287');
  const rows = [];
  const inStock = list.filter((p) => p.items.length > 0).slice(0, 25);
  if (inStock.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`c:${type}:buy`).setPlaceholder('구매할 상품을 선택하세요')
        .addOptions(inStock.map((p) => new StringSelectMenuOptionBuilder()
          .setLabel(p.name.slice(0, 100)).setDescription(`${fmt(p.price)}원 · 재고 ${p.items.length}`).setValue(p.id))),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`c:${type}:open`).setLabel('충전하기').setEmoji('💰').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`c:${type}:bal`).setLabel('내 잔액').setEmoji('💳').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`c:${type}:my`).setLabel('구매내역/후기').setEmoji('🧾').setStyle(ButtonStyle.Primary),
  ));
  return { embeds: [embed], components: rows };
}

async function fetchChannel(gid, channelId) {
  const client = ctx.getClient();
  const guild = client ? client.guilds.cache.get(gid) : null;
  const ch = guild && channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  return ch && ch.isTextBased() ? ch : null;
}

async function sendShopPanel(gid, type) {
  const cfg = getCfg(gid, type);
  if (!cfg.shopChannelId) throw new Error('상점 패널 채널을 먼저 선택하고 저장하세요.');
  const ch = await fetchChannel(gid, cfg.shopChannelId);
  if (!ch) throw new Error('상점 패널 채널을 찾을 수 없습니다.');
  const payload = buildShopPayload(gid, type);
  if (cfg.shopMessageId) {
    try {
      const old = await ch.messages.fetch(cfg.shopMessageId);
      await old.edit(payload);
      return '기존 상점 패널을 수정했습니다.';
    } catch (_) { /* 새로 전송 */ }
  }
  const m = await ch.send(payload);
  setCfg(gid, type, { ...getCfg(gid, type), shopMessageId: m.id });
  return '상점 패널을 전송했습니다.';
}

// 재고/상품 변경 시 상점 패널 메시지를 조용히 갱신
function refreshShop(gid, type) {
  const cfg = getCfg(gid, type);
  if (!cfg.shopChannelId || !cfg.shopMessageId || !ctx.isOnline()) return;
  fetchChannel(gid, cfg.shopChannelId)
    .then((ch) => (ch ? ch.messages.fetch(cfg.shopMessageId) : null))
    .then((m) => (m ? m.edit(buildShopPayload(gid, type)) : null))
    .catch(() => {});
}

async function onBuy(i, type) {
  const p = store.products.find((x) => x.id === i.values[0] && x.guildId === i.guildId && x.type === type);
  if (!p || !p.items.length) return i.reply({ content: '❌ 품절이거나 판매 중지된 상품입니다.', flags: EPH });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`c:${type}:ok:${p.id}`).setLabel('구매 확정').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
  return i.reply({
    content: `🛒 **${p.name}**\n가격: ${fmt(p.price)}원\n내 잔액: ${fmt(getBal(i.guildId, i.user.id))}원\n\n구매하시겠어요?`,
    components: [row],
    flags: EPH,
  });
}

async function onOk(i, type, pid) {
  const p = store.products.find((x) => x.id === pid && x.guildId === i.guildId && x.type === type);
  if (!p || !p.items.length) return i.update({ content: '❌ 품절이거나 판매 중지된 상품입니다.', components: [] });
  const bal = getBal(i.guildId, i.user.id);
  if (bal < p.price) {
    return i.update({ content: `❌ 잔액이 부족합니다. (현재 ${fmt(bal)}원 / 필요 ${fmt(p.price)}원)`, components: [] });
  }
  // 아래 구간은 동기 처리라 재고/잔액이 중복 차감되지 않음
  const item = p.items.shift();
  addBal(i.guildId, i.user.id, -p.price);
  const rec = {
    id: newId(), guildId: i.guildId, type, userId: i.user.id, productId: p.id,
    productName: p.name, price: p.price, item, at: Date.now(), reviewed: false,
  };
  store.purchases.push(rec);
  save();
  refreshShop(i.guildId, type);

  const cfg = getCfg(i.guildId, type);
  const after = getBal(i.guildId, i.user.id);
  const logCh = await fetchChannel(i.guildId, cfg.buyLogChannelId);
  if (logCh) {
    logCh.send({
      content: `🛒 [${TYPES[type]}] <@${i.user.id}> 님이 **${p.name}** 구매 (${fmt(p.price)}원 · 잔액 ${fmt(after)}원)`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  const fence = '`'.repeat(3);
  const safeItem = String(item).split(fence).join('ʼʼʼ');
  const body = `📦 **${p.name}**\n${fence}\n${safeItem}\n${fence}`;
  i.user.send(`✅ 구매 내역\n${body}`).catch(() => {});
  const rows = cfg.reviewChannelId ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`c:${type}:rv:${rec.id}`).setLabel('후기 작성').setEmoji('⭐').setStyle(ButtonStyle.Primary),
  )] : [];
  return i.update({ content: `✅ 구매가 완료되었습니다!\n결제: ${fmt(p.price)}원 · 잔액: ${fmt(after)}원\n\n${body}`, components: rows });
}

async function onMy(i, type) {
  const list = store.purchases
    .filter((x) => x.guildId === i.guildId && x.type === type && x.userId === i.user.id)
    .slice(-5).reverse();
  if (!list.length) return i.reply({ content: '🧾 구매 내역이 없습니다.', flags: EPH });
  const cfg = getCfg(i.guildId, type);
  const lines = list.map((x) => `• ${x.productName} · ${fmt(x.price)}원 · <t:${Math.floor(x.at / 1000)}:f>${x.reviewed ? ' · ⭐후기 작성됨' : ''}`).join('\n');
  const btns = cfg.reviewChannelId
    ? list.filter((x) => !x.reviewed).map((x) => new ButtonBuilder()
      .setCustomId(`c:${type}:rv:${x.id}`).setLabel(`후기: ${x.productName}`.slice(0, 80)).setEmoji('⭐').setStyle(ButtonStyle.Secondary))
    : [];
  return i.reply({
    content: `🧾 **최근 구매 내역**\n${lines}`,
    components: btns.length ? [new ActionRowBuilder().addComponents(btns)] : [],
    flags: EPH,
  });
}

function findOwnPurchase(i, pid) {
  return store.purchases.find((x) => x.id === pid && x.guildId === i.guildId && x.userId === i.user.id);
}

async function onRv(i, type, pid, cfg) {
  const rec = findOwnPurchase(i, pid);
  if (!rec) return i.reply({ content: '❌ 구매 내역을 찾을 수 없습니다.', flags: EPH });
  if (rec.reviewed) return i.reply({ content: '✅ 이미 후기를 작성한 구매입니다.', flags: EPH });
  if (!cfg.reviewChannelId) return i.reply({ content: '❌ 후기 채널이 설정되지 않았습니다.', flags: EPH });
  const modal = new ModalBuilder().setCustomId(`c:${type}:rvm:${pid}`).setTitle('구매 후기 작성').addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('rating').setLabel('별점 (1~5)').setStyle(TextInputStyle.Short)
        .setMinLength(1).setMaxLength(1).setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('text').setLabel('후기 내용').setStyle(TextInputStyle.Paragraph)
        .setMinLength(2).setMaxLength(500).setRequired(true),
    ),
  );
  return i.showModal(modal);
}

async function onRvm(i, type, pid, cfg) {
  const rec = findOwnPurchase(i, pid);
  if (!rec) return i.reply({ content: '❌ 구매 내역을 찾을 수 없습니다.', flags: EPH });
  if (rec.reviewed) return i.reply({ content: '✅ 이미 후기를 작성한 구매입니다.', flags: EPH });
  const rating = parseInt(i.fields.getTextInputValue('rating'), 10);
  if (!(rating >= 1 && rating <= 5)) return i.reply({ content: '❌ 별점은 1~5 사이 숫자로 입력해주세요.', flags: EPH });
  const text = i.fields.getTextInputValue('text').trim();
  const ch = await fetchChannel(i.guildId, cfg.reviewChannelId);
  if (!ch) return i.reply({ content: '❌ 후기 채널을 찾을 수 없습니다. 관리자에게 문의하세요.', flags: EPH });
  const embed = new EmbedBuilder()
    .setTitle(`${'⭐'.repeat(rating)}${'☆'.repeat(5 - rating)} 구매후기`)
    .setDescription(text)
    .addFields({ name: '상품', value: rec.productName.slice(0, 200) })
    .setAuthor({ name: i.user.displayName || i.user.username, iconURL: i.user.displayAvatarURL() })
    .setColor('#FEE75C')
    .setTimestamp();
  await ch.send({ embeds: [embed] });
  rec.reviewed = true;
  save();
  return i.reply({ content: '✅ 후기가 등록되었습니다. 감사합니다!', flags: EPH });
}

// ───────────── 디스코드 인터랙션 (customId: c:<종류>:<동작>[:<값>]) ─────────────
async function handleInteraction(i) {
  const [, type, action, pid] = i.customId.split(':');
  if (!TYPES[type]) return;
  const cfg = getCfg(i.guildId, type);

  if (action === 'bal') {
    return i.reply({ content: `💳 현재 잔액: ${fmt(getBal(i.guildId, i.user.id))}원`, flags: EPH });
  }

  if (action === 'my') return onMy(i, type);

  if (!cfg.enabled) return i.reply({ content: '❌ 현재 충전 기능이 꺼져 있습니다.', flags: EPH });

  if (action === 'buy' && i.isStringSelectMenu()) return onBuy(i, type);
  if (action === 'ok' && i.isButton()) return onOk(i, type, pid);
  if (action === 'rv' && i.isButton()) return onRv(i, type, pid, cfg);
  if (action === 'rvm' && i.isModalSubmit()) return onRvm(i, type, pid, cfg);

  if (action === 'open') {
    if (!cfg.bank || !cfg.number) {
      return i.reply({ content: '❌ 입금 계좌가 등록되지 않았습니다. 관리자에게 문의하세요.', flags: EPH });
    }
    const modal = new ModalBuilder().setCustomId(`c:${type}:modal`).setTitle(`${TYPES[type]} 충전 신청`).addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('입금자명 (실제 입금할 이름)')
          .setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(20).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('amount').setLabel('충전 금액 (원)')
          .setPlaceholder(`${fmt(cfg.minAmount)} ~ ${fmt(cfg.maxAmount)}`)
          .setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(10).setRequired(true),
      ),
    );
    return i.showModal(modal);
  }

  if (action === 'modal' && i.isModalSubmit()) {
    const name = i.fields.getTextInputValue('name').trim();
    const amount = parseInt(i.fields.getTextInputValue('amount').replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(amount) || amount < cfg.minAmount || amount > cfg.maxAmount) {
      return i.reply({ content: `❌ 충전 금액은 ${fmt(cfg.minAmount)}원 ~ ${fmt(cfg.maxAmount)}원 사이여야 합니다.`, flags: EPH });
    }
    expireOld();
    for (const r of store.requests) {
      if (r.status === 'pending' && r.guildId === i.guildId && r.type === type && r.userId === i.user.id) r.status = 'canceled';
    }
    const r = {
      id: newId(), guildId: i.guildId, type, userId: i.user.id, name, amount,
      status: 'pending', createdAt: Date.now(), deposited: false, via: '',
    };
    store.requests.push(r);
    save();
    const until = Math.floor((r.createdAt + cfg.expireMinutes * 60000) / 1000);
    return i.reply({
      content: [
        '💳 **충전 신청이 접수되었습니다.**',
        `은행: ${cfg.bank}`,
        `계좌번호: ${cfg.number}`,
        `예금주: ${cfg.holder}`,
        `입금 금액: **${fmt(amount)}원** (정확히 이 금액)`,
        `입금자명: **${name}** (반드시 이 이름으로)`,
        `유효 시간: <t:${until}:R> 까지`,
        cfg.auto ? '✅ 입금이 확인되면 자동으로 충전됩니다.' : '⏳ 입금 후 관리자가 승인하면 충전됩니다.',
      ].join('\n'),
      flags: EPH,
    });
  }
}

async function sendPanel(gid, type) {
  const client = ctx.getClient();
  const cfg = getCfg(gid, type);
  if (!cfg.channelId) throw new Error('패널 채널을 먼저 선택하고 저장하세요.');
  const guild = client.guilds.cache.get(gid);
  const ch = guild ? await guild.channels.fetch(cfg.channelId).catch(() => null) : null;
  if (!ch || !ch.isTextBased()) throw new Error('패널 채널을 찾을 수 없습니다.');
  const payload = {
    embeds: [new EmbedBuilder().setTitle(cfg.title).setDescription(cfg.desc).setColor('#5865F2')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`c:${type}:open`).setLabel('충전하기').setEmoji('💰').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`c:${type}:bal`).setLabel('내 잔액').setEmoji('💳').setStyle(ButtonStyle.Secondary),
    )],
  };
  if (cfg.messageId) {
    try {
      const old = await ch.messages.fetch(cfg.messageId);
      await old.edit(payload);
      return '기존 충전 패널을 수정했습니다.';
    } catch (_) { /* 새로 전송 */ }
  }
  const m = await ch.send(payload);
  setCfg(gid, type, { ...cfg, messageId: m.id });
  return '충전 패널을 전송했습니다.';
}

// ───────────── 웹 API ─────────────
function guildOf(gid) {
  const c = ctx.getClient();
  if (!c || !ctx.isOnline()) throw new Error('봇이 실행 중이 아닙니다. 먼저 봇을 시작하세요.');
  const g = c.guilds.cache.get(gid);
  if (!g) throw new Error('봇이 해당 서버에 없습니다.');
  return g;
}

function typeOf(req) {
  if (!TYPES[req.params.type]) throw new Error('잘못된 자판기 종류입니다.');
  return req.params.type;
}

function sanitizeCfg(b, old) {
  const s = (v, m) => String(v === undefined || v === null ? '' : v).trim().slice(0, m);
  const n = (v, min, max, d) => {
    const x = parseInt(v, 10);
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d;
  };
  const id = (v) => {
    const x = s(v, 25);
    if (x && !/^\d{5,25}$/.test(x)) throw new Error('잘못된 ID 값입니다.');
    return x;
  };
  const c = {
    ...old,
    enabled: !!b.enabled,
    auto: !!b.auto,
    bank: s(b.bank, 30), number: s(b.number, 40), holder: s(b.holder, 30),
    minAmount: n(b.minAmount, 100, 100000000, 1000),
    maxAmount: n(b.maxAmount, 100, 100000000, 500000),
    expireMinutes: n(b.expireMinutes, 5, 1440, 30),
    channelId: id(b.channelId), logChannelId: id(b.logChannelId),
    shopChannelId: id(b.shopChannelId), buyLogChannelId: id(b.buyLogChannelId), reviewChannelId: id(b.reviewChannelId),
    title: s(b.title, 256) || DEF.title,
    desc: s(b.desc, 2000) || DEF.desc,
  };
  if (c.minAmount > c.maxAmount) throw new Error('최소 금액이 최대 금액보다 큽니다.');
  if (c.enabled && (!c.bank || !c.number || !c.holder)) {
    throw new Error('충전을 켜려면 은행, 계좌번호, 예금주를 모두 입력하세요.');
  }
  return c;
}

function setup(app, c) {
  ctx = c;
  dataFile = path.join(c.dataDir, 'charge.json');
  load();
  setInterval(expireOld, 60000).unref();
  const { auth, wrap } = c;

  app.get('/charge', (req, res) => res.type('html').send(CHARGE_HTML));

  app.get('/api/charge/:gid/:type', auth, wrap(async (req, res) => {
    const gid = req.params.gid;
    const type = typeOf(req);
    const g = guildOf(gid);
    let cfg = getCfg(gid, type);
    if (!cfg.key) { cfg = { ...cfg, key: newKey() }; setCfg(gid, type, cfg); }
    expireOld();
    const channels = g.channels.cache
      .filter((x) => x.type === ChannelType.GuildText || x.type === ChannelType.GuildAnnouncement)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((x) => ({ id: x.id, name: x.name }));
    const open = store.requests
      .filter((r) => r.guildId === gid && r.type === type && (r.status === 'pending' || r.status === 'expired'))
      .slice(-30).reverse();
    const recent = store.requests.filter((r) => r.guildId === gid && r.status === 'done').slice(-15).reverse();
    const ranking = Object.entries(store.balances)
      .filter(([k]) => k.startsWith(gid + ':'))
      .map(([k, v]) => ({ userId: k.split(':')[1], balance: v }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 15);
    const products = prodsOf(gid, type).map((p) => ({ id: p.id, name: p.name, price: p.price, desc: p.desc, stock: p.items.length }));
    const purchases = store.purchases
      .filter((x) => x.guildId === gid && x.type === type)
      .slice(-15).reverse()
      .map((x) => ({ id: x.id, userId: x.userId, productName: x.productName, price: x.price, at: x.at, reviewed: x.reviewed }));
    res.json({ config: cfg, channels, open, recent, ranking, products, purchases });
  }));

  app.post('/api/charge/:gid/:type/config', auth, wrap(async (req, res) => {
    const gid = req.params.gid;
    const type = typeOf(req);
    const g = guildOf(gid);
    const cfg = sanitizeCfg(req.body, getCfg(gid, type));
    for (const k of ['channelId', 'logChannelId', 'shopChannelId', 'buyLogChannelId', 'reviewChannelId']) {
      if (cfg[k] && !g.channels.cache.has(cfg[k])) throw new Error('선택한 채널이 서버에 없습니다.');
    }
    if (!cfg.key) cfg.key = newKey();
    setCfg(gid, type, cfg);
    res.json({ ok: true });
  }));

  app.post('/api/charge/:gid/:type/key', auth, wrap(async (req, res) => {
    const gid = req.params.gid;
    const type = typeOf(req);
    guildOf(gid);
    setCfg(gid, type, { ...getCfg(gid, type), key: newKey() });
    res.json({ ok: true });
  }));

  app.post('/api/charge/:gid/:type/panel', auth, wrap(async (req, res) => {
    const type = typeOf(req);
    guildOf(req.params.gid);
    res.json({ ok: true, message: await sendPanel(req.params.gid, type) });
  }));

  app.post('/api/charge/:gid/:type/approve', auth, wrap(async (req, res) => {
    const type = typeOf(req);
    const r = store.requests.find((x) => x.id === req.body.id && x.guildId === req.params.gid && x.type === type);
    if (!r) throw new Error('요청을 찾을 수 없습니다.');
    finish(r, 'manual');
    res.json({ ok: true });
  }));

  app.post('/api/charge/:gid/:type/cancel', auth, wrap(async (req, res) => {
    const type = typeOf(req);
    const r = store.requests.find((x) => x.id === req.body.id && x.guildId === req.params.gid && x.type === type);
    if (!r) throw new Error('요청을 찾을 수 없습니다.');
    if (r.status !== 'pending' && r.status !== 'expired') throw new Error('이미 처리된 요청입니다.');
    r.status = 'canceled';
    save();
    res.json({ ok: true });
  }));

  // 관리자 수동 충전/차감 (양수=충전, 음수=차감)
  app.post('/api/charge/:gid/:type/adjust', auth, wrap(async (req, res) => {
    const gid = req.params.gid;
    const type = typeOf(req);
    guildOf(gid);
    const userId = String(req.body.userId || '').trim();
    if (!/^\d{5,25}$/.test(userId)) throw new Error('유저 ID가 올바르지 않습니다.');
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000000) {
      throw new Error('금액이 올바르지 않습니다. (음수 입력 시 차감)');
    }
    if (amount < 0 && getBal(gid, userId) + amount < 0) throw new Error('유저 잔액이 부족합니다.');
    const now = Date.now();
    const r = {
      id: newId(), guildId: gid, type, userId, name: '관리자', amount,
      status: 'done', createdAt: now, doneAt: now, via: 'admin', deposited: true,
    };
    addBal(gid, userId, amount);
    store.requests.push(r);
    save();
    notify(r, 'admin').catch(() => {});
    res.json({ ok: true, balance: getBal(gid, userId) });
  }));

  // ───── 상품 관리 / 상점 패널 ─────
  const findProduct = (req, type) =>
    store.products.find((x) => x.id === req.body.id && x.guildId === req.params.gid && x.type === type);

  app.post('/api/charge/:gid/:type/products', auth, wrap(async (req, res) => {
    const gid = req.params.gid;
    const type = typeOf(req);
    guildOf(gid);
    const name = String(req.body.name || '').trim().slice(0, 50);
    const price = parseInt(String(req.body.price || '').replace(/[^\d]/g, ''), 10);
    if (!name) throw new Error('상품명을 입력하세요.');
    if (!Number.isFinite(price) || price < 1 || price > 100000000) throw new Error('가격이 올바르지 않습니다.');
    if (prodsOf(gid, type).length >= 25) throw new Error('상품은 종류당 최대 25개까지 등록할 수 있습니다.');
    store.products.push({
      id: newId(), guildId: gid, type, name, price,
      desc: String(req.body.desc || '').trim().slice(0, 100), items: [],
    });
    save();
    refreshShop(gid, type);
    res.json({ ok: true });
  }));

  app.post('/api/charge/:gid/:type/products/stock', auth, wrap(async (req, res) => {
    const gid = req.params.gid;
    const type = typeOf(req);
    guildOf(gid);
    const p = findProduct(req, type);
    if (!p) throw new Error('상품을 찾을 수 없습니다.');
    const lines = String(req.body.items || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) throw new Error('재고 내용을 입력하세요.');
    if (lines.some((x) => x.length > 1000)) throw new Error('재고 한 줄은 1000자 이하여야 합니다.');
    if (p.items.length + lines.length > 5000) throw new Error('재고는 상품당 최대 5000개까지 가능합니다.');
    p.items.push(...lines);
    save();
    refreshShop(gid, type);
    res.json({ ok: true, stock: p.items.length });
  }));

  app.post('/api/charge/:gid/:type/products/delete', auth, wrap(async (req, res) => {
    const gid = req.params.gid;
    const type = typeOf(req);
    guildOf(gid);
    const p = findProduct(req, type);
    if (!p) throw new Error('상품을 찾을 수 없습니다.');
    store.products = store.products.filter((x) => x !== p);
    save();
    refreshShop(gid, type);
    res.json({ ok: true });
  }));

  app.post('/api/charge/:gid/:type/shop/panel', auth, wrap(async (req, res) => {
    const type = typeOf(req);
    guildOf(req.params.gid);
    res.json({ ok: true, message: await sendShopPanel(req.params.gid, type) });
  }));

  // 입금 문자 웹훅 (인증 없이 키로 검증) — 안드로이드 문자 전달 앱 / 아이폰 단축어에서 호출
  // body: { key, text } 또는 { key, name, amount }
  app.post('/api/deposit/:gid/:type', express.urlencoded({ extended: false }), (req, res) => {
    const { gid, type } = req.params;
    const body = req.body || {};
    const cfg = TYPES[type] ? store.configs[cfgKey(gid, type)] : null;
    const key = String(body.key || req.headers['x-key'] || '');
    if (!cfg || !cfg.key || !safeEq(key, cfg.key)) return res.status(401).json({ error: 'invalid key' });
    if (!cfg.enabled) return res.json({ ok: true, matched: false, reason: 'disabled' });

    const text = String(body.text || '').slice(0, 2000);
    const amounts = [];
    if (body.amount) amounts.push(parseInt(String(body.amount).replace(/[^\d]/g, ''), 10));
    const re = /(\d{1,3}(?:,\d{3})+|\d+)\s*원/g;
    let m;
    while ((m = re.exec(text)) !== null) amounts.push(parseInt(m[1].replace(/,/g, ''), 10));
    const hay = `${text} ${String(body.name || '')}`.replace(/\s+/g, '');

    expireOld();
    const hit = store.requests
      .filter((r) => r.guildId === gid && r.type === type && r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .find((r) => amounts.includes(r.amount) && hay.includes(r.name.replace(/\s+/g, '')));
    if (!hit) return res.json({ ok: true, matched: false });

    if (!getCfg(gid, type).auto) {
      hit.deposited = true; // 입금 확인됨 → 관리자 수동 승인 대기
      save();
      return res.json({ ok: true, matched: true, auto: false });
    }
    finish(hit, 'auto');
    return res.json({ ok: true, matched: true, auto: true });
  });
}

return { setup, handleInteraction };
})();


const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const EPH = MessageFlags.Ephemeral;

// ───────────────────────── 데이터 저장소 ─────────────────────────
let db = { token: '', autoStart: true, guilds: {} };

function loadDb() {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('데이터 로드 실패:', e.message);
  }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const DEFAULT_CFG = {
  mode: 'button', // button | emoji | captcha
  roleId: '', removeRoleId: '', channelId: '', logChannelId: '', messageId: '',
  welcomeChannelId: '', // 비워두면 환영 메시지 사용 안 함
  welcomeMessage: '{멘션}님, {서버}에 오신 것을 환영합니다! 🎉 (현재 {인원}명)',
  title: '✅ 서버 인증', description: '아래 버튼을 눌러 인증을 진행해주세요.',
  buttonLabel: '인증하기', color: '#5865F2',
  emojis: ['🍎', '🍌', '🍇', '🍓', '🍊', '🍉', '🍒', '🥝'],
  captchaLength: 5, maxAttempts: 3, lockMinutes: 5, timeoutSeconds: 120,
};

function getCfg(gid) {
  return { ...DEFAULT_CFG, ...(db.guilds[gid] || {}) };
}

// ───────────────────────── 유틸 ─────────────────────────
function rnd(a, b) { return a + Math.random() * (b - a); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ───────────────────────── 캡챠 이미지 (폰트 없이 직접 획으로 그림) ─────────────────────────
// 좌표: x 0~4, y 0~6
const GLYPHS = {
  '2': [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 0, 6, 4, 6]],
  '3': [[0, 0, 4, 0, 2, 3, 3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5]],
  '4': [[3, 6, 3, 0, 0, 4, 4, 4]],
  '5': [[4, 0, 0, 0, 0, 3, 3, 3, 4, 4, 4, 5, 3, 6, 0, 6]],
  '6': [[4, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3]],
  '7': [[0, 0, 4, 0, 1, 6]],
  '8': [[1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1, 3, 0, 2, 0, 1, 1, 0], [1, 3, 3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5, 0, 4, 1, 3]],
  '9': [[4, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 0, 6]],
  A: [[0, 6, 0, 2, 2, 0, 4, 2, 4, 6], [0, 3, 4, 3]],
  B: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [3, 3, 4, 2, 4, 1, 3, 0, 0, 0]],
  C: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5]],
  D: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 1, 3, 0, 0, 0]],
  E: [[4, 0, 0, 0, 0, 6, 4, 6], [0, 3, 3, 3]],
  F: [[4, 0, 0, 0, 0, 6], [0, 3, 3, 3]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  K: [[0, 0, 0, 6], [4, 0, 0, 3, 4, 6]],
  L: [[0, 0, 0, 6, 4, 6]],
  M: [[0, 6, 0, 0, 2, 3, 4, 0, 4, 6]],
  N: [[0, 6, 0, 0, 4, 6, 4, 0]],
  P: [[0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3]],
  R: [[0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3], [2, 3, 4, 6]],
  T: [[0, 0, 4, 0], [2, 0, 2, 6]],
  U: [[0, 0, 0, 5, 1, 6, 3, 6, 4, 5, 4, 0]],
  X: [[0, 0, 4, 6], [4, 0, 0, 6]],
  Y: [[0, 0, 2, 3, 4, 0], [2, 3, 2, 6]],
};
const CHARSET = Object.keys(GLYPHS);

function makeCaptcha(len) {
  let code = '';
  for (let n = 0; n < len; n++) code += CHARSET[crypto.randomInt(CHARSET.length)];
  const W = Math.max(340, len * 68), H = 120;
  const cv = createCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = '#23272a';
  g.fillRect(0, 0, W, H);
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const noise = (cnt, alpha) => {
    for (let n = 0; n < cnt; n++) {
      g.strokeStyle = `rgba(${rnd(80, 255) | 0},${rnd(80, 255) | 0},${rnd(80, 255) | 0},${alpha})`;
      g.lineWidth = rnd(1, 2.5);
      g.beginPath();
      g.moveTo(rnd(0, W), rnd(0, H));
      g.bezierCurveTo(rnd(0, W), rnd(0, H), rnd(0, W), rnd(0, H), rnd(0, W), rnd(0, H));
      g.stroke();
    }
  };
  noise(6, 0.6);

  const cw = W / (len + 0.5);
  for (let n = 0; n < len; n++) {
    const gl = GLYPHS[code[n]];
    const sx = rnd(8, 11), sy = rnd(9, 12), ang = rnd(-0.35, 0.35);
    const cx = cw * (n + 0.75), cy = H / 2 + rnd(-8, 8);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    g.strokeStyle = `rgb(${rnd(150, 255) | 0},${rnd(150, 255) | 0},${rnd(150, 255) | 0})`;
    g.lineWidth = rnd(3, 4.5);
    for (const line of gl) {
      g.beginPath();
      for (let k = 0; k < line.length; k += 2) {
        const x = (line[k] - 2) * sx + rnd(-1, 1);
        const y = (line[k + 1] - 3) * sy + rnd(-1, 1);
        const px = cx + x * cos - y * sin;
        const py = cy + x * sin + y * cos;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
  }
  noise(4, 0.7);
  for (let n = 0; n < 150; n++) {
    g.fillStyle = `rgba(255,255,255,${rnd(0.1, 0.5)})`;
    g.fillRect(rnd(0, W), rnd(0, H), 2, 2);
  }
  return { code, buffer: cv.toBuffer('image/png') };
}

// ───────────────────────── 인증 상태 (메모리) ─────────────────────────
const sessions = new Map(); // `${guildId}:${userId}` -> { answer | code, opts, expires }
const fails = new Map(); // `${guildId}:${userId}` -> { count, lockedUntil }

const keyOf = (i) => `${i.guildId}:${i.user.id}`;

function lockedMinutes(k) {
  const s = fails.get(k);
  return s && s.lockedUntil > Date.now() ? Math.ceil((s.lockedUntil - Date.now()) / 60000) : 0;
}

function registerFail(k, cfg) {
  const s = fails.get(k) || { count: 0, lockedUntil: 0 };
  s.count++;
  let locked = false;
  if (s.count >= cfg.maxAttempts) {
    s.lockedUntil = Date.now() + cfg.lockMinutes * 60000;
    s.count = 0;
    locked = true;
  }
  fails.set(k, s);
  return { locked, remaining: cfg.maxAttempts - s.count };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
  for (const [k, v] of fails) if (v.lockedUntil < now && v.count === 0) fails.delete(k);
  for (const [k, v] of webSessions) if (v < now) webSessions.delete(k);
}, 5 * 60 * 1000).unref();

// ───────────────────────── 봇 로직 ─────────────────────────
let client = null;
let botState = 'offline'; // offline | starting | online
let botError = '';

async function sendLog(i, cfg, text) {
  if (!cfg.logChannelId) return;
  const ch = await i.guild.channels.fetch(cfg.logChannelId).catch(() => null);
  if (ch && ch.isTextBased()) ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

// 인증 완료 시 설정한 채널에 환영 인사 전송 ({멘션} {유저} {서버} {인원} 치환)
async function sendWelcome(i, cfg) {
  if (!cfg.welcomeChannelId) return;
  const ch = await i.guild.channels.fetch(cfg.welcomeChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;
  const text = (cfg.welcomeMessage || DEFAULT_CFG.welcomeMessage)
    .replaceAll('{멘션}', `<@${i.user.id}>`)
    .replaceAll('{유저}', i.user.username)
    .replaceAll('{서버}', i.guild.name)
    .replaceAll('{인원}', String(i.guild.memberCount));
  ch.send({ content: text.slice(0, 2000), allowedMentions: { users: [i.user.id] } }).catch(() => {});
}

async function grant(i, cfg) {
  const role = i.guild.roles.cache.get(cfg.roleId);
  if (!role) throw new Error('인증 역할이 설정되지 않았거나 존재하지 않습니다. 관리자에게 문의하세요.');
  await i.member.roles.add(role, '인증 완료');
  if (cfg.removeRoleId && i.guild.roles.cache.has(cfg.removeRoleId)) {
    await i.member.roles.remove(cfg.removeRoleId, '인증 완료').catch(() => {});
  }
  fails.delete(keyOf(i));
  sessions.delete(keyOf(i));
  const label = { button: '버튼', emoji: '이모지', captcha: '캡챠' }[cfg.mode];
  sendLog(i, cfg, `✅ ${i.user.tag} (${i.user.id}) 님이 ${label} 인증을 완료했습니다.`);
  sendWelcome(i, cfg);
}

async function onStart(i) {
  const cfg = getCfg(i.guildId);
  if (!cfg.roleId) return i.reply({ content: '❌ 인증 역할이 설정되지 않았습니다. 관리자에게 문의하세요.', flags: EPH });
  if (i.member.roles.cache.has(cfg.roleId)) return i.reply({ content: '✅ 이미 인증된 상태입니다.', flags: EPH });
  const lock = lockedMinutes(keyOf(i));
  if (lock) return i.reply({ content: `🔒 실패 횟수를 초과했습니다. ${lock}분 후 다시 시도해주세요.`, flags: EPH });

  if (cfg.mode === 'button') {
    await grant(i, cfg);
    return i.reply({ content: '✅ 인증이 완료되었습니다!', flags: EPH });
  }
  if (cfg.mode === 'emoji') return sendEmojiChallenge(i, cfg, '');
  return sendCaptcha(i, cfg, '');
}

async function sendEmojiChallenge(i, cfg, note) {
  const pool = cfg.emojis.length >= 4 ? cfg.emojis : DEFAULT_CFG.emojis;
  const opts = shuffle([...pool]).slice(0, Math.min(5, pool.length));
  const answer = crypto.randomInt(opts.length);
  sessions.set(keyOf(i), { answer, opts, expires: Date.now() + cfg.timeoutSeconds * 1000 });
  const row = new ActionRowBuilder().addComponents(
    opts.map((e, n) => new ButtonBuilder().setCustomId(`v:emoji:${n}`).setStyle(ButtonStyle.Secondary).setEmoji(e)),
  );
  const payload = {
    content: `${note}🔎 아래 버튼 중 ${opts[answer]} 이모지를 선택해주세요. (${cfg.timeoutSeconds}초 이내)`,
    components: [row],
  };
  if (i.isButton() && i.customId.startsWith('v:emoji:')) return i.update(payload);
  return i.reply({ ...payload, flags: EPH });
}

async function onEmoji(i) {
  const cfg = getCfg(i.guildId);
  const k = keyOf(i);
  const s = sessions.get(k);
  if (!s || s.opts === undefined || s.expires < Date.now()) {
    sessions.delete(k);
    return i.update({ content: '⌛ 시간이 만료되었습니다. 인증 버튼을 다시 눌러주세요.', components: [] });
  }
  const idx = Number(i.customId.split(':')[2]);
  if (idx === s.answer) {
    await grant(i, cfg);
    return i.update({ content: '✅ 이모지 인증이 완료되었습니다!', components: [] });
  }
  sessions.delete(k);
  const r = registerFail(k, cfg);
  sendLog(i, cfg, `⚠️ ${i.user.tag} (${i.user.id}) 님이 이모지 인증에 실패했습니다.${r.locked ? ' (잠금)' : ''}`);
  if (r.locked) {
    return i.update({ content: `🔒 실패 횟수를 초과했습니다. ${cfg.lockMinutes}분 후 다시 시도해주세요.`, components: [] });
  }
  return sendEmojiChallenge(i, cfg, `❌ 틀렸습니다. (남은 기회 ${r.remaining}회)\n`);
}

async function sendCaptcha(i, cfg, note) {
  const { code, buffer } = makeCaptcha(cfg.captchaLength);
  sessions.set(keyOf(i), { code, expires: Date.now() + cfg.timeoutSeconds * 1000 });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('v:cap:open').setLabel('코드 입력').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('v:cap:new').setLabel('새 코드').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );
  const payload = {
    content: `${note}🔐 이미지에 보이는 코드를 입력해주세요. (${cfg.timeoutSeconds}초 이내)`,
    files: [new AttachmentBuilder(buffer, { name: 'captcha.png' })],
    components: [row],
  };
  const isUpdate = i.isModalSubmit() || (i.isButton() && i.customId === 'v:cap:new');
  if (isUpdate) return i.update({ ...payload, attachments: [] });
  return i.reply({ ...payload, flags: EPH });
}

async function onCaptchaOpen(i) {
  const s = sessions.get(keyOf(i));
  if (!s || s.code === undefined || s.expires < Date.now()) {
    sessions.delete(keyOf(i));
    return i.update({ content: '⌛ 시간이 만료되었습니다. 인증 버튼을 다시 눌러주세요.', components: [], attachments: [] });
  }
  const modal = new ModalBuilder().setCustomId('v:cap:modal').setTitle('캡챠 인증').addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('code').setLabel('이미지에 보이는 코드').setStyle(TextInputStyle.Short)
        .setMinLength(1).setMaxLength(12).setRequired(true),
    ),
  );
  return i.showModal(modal);
}

async function onCaptchaModal(i) {
  const cfg = getCfg(i.guildId);
  const k = keyOf(i);
  const s = sessions.get(k);
  if (!s || s.code === undefined || s.expires < Date.now()) {
    sessions.delete(k);
    return i.update({ content: '⌛ 시간이 만료되었습니다. 인증 버튼을 다시 눌러주세요.', components: [], attachments: [] });
  }
  const input = i.fields.getTextInputValue('code').trim().toUpperCase();
  if (input === s.code) {
    await grant(i, cfg);
    return i.update({ content: '✅ 캡챠 인증이 완료되었습니다!', components: [], attachments: [] });
  }
  sessions.delete(k);
  const r = registerFail(k, cfg);
  sendLog(i, cfg, `⚠️ ${i.user.tag} (${i.user.id}) 님이 캡챠 인증에 실패했습니다.${r.locked ? ' (잠금)' : ''}`);
  if (r.locked) {
    return i.update({ content: `🔒 실패 횟수를 초과했습니다. ${cfg.lockMinutes}분 후 다시 시도해주세요.`, components: [], attachments: [] });
  }
  return sendCaptcha(i, cfg, `❌ 코드가 틀렸습니다. (남은 기회 ${r.remaining}회)\n`);
}

async function handleInteraction(i) {
  try {
    if (!i.inGuild() || !i.guild) return;
    const id = i.customId;
    if ((i.isButton() || i.isModalSubmit() || i.isStringSelectMenu()) && id.startsWith('c:')) return await charge.handleInteraction(i);
    if (i.isButton()) {
      if (id === 'v:start') return await onStart(i);
      if (id.startsWith('v:emoji:')) return await onEmoji(i);
      if (id === 'v:cap:open') return await onCaptchaOpen(i);
      if (id === 'v:cap:new') return await sendCaptcha(i, getCfg(i.guildId), '');
    } else if (i.isModalSubmit() && id === 'v:cap:modal') {
      return await onCaptchaModal(i);
    }
  } catch (e) {
    console.error('인터랙션 오류:', e);
    const msg = { content: `❌ 오류: ${e.message}`, flags: EPH };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {});
    else i.reply(msg).catch(() => {});
  }
}

// ───────────────────────── 봇 실행 / 중지 ─────────────────────────
async function startBot() {
  if (client) throw new Error('이미 실행 중입니다.');
  if (!db.token) throw new Error('봇 토큰을 먼저 저장하세요.');
  const c = new Client({ intents: [GatewayIntentBits.Guilds] });
  client = c;
  botState = 'starting';
  botError = '';
  c.once(Events.ClientReady, () => {
    botState = 'online';
    console.log(`봇 로그인 완료: ${c.user.tag}`);
  });
  c.on(Events.InteractionCreate, handleInteraction);
  c.on(Events.Error, (e) => console.error('클라이언트 오류:', e));
  try {
    await c.login(db.token);
  } catch (e) {
    client = null;
    botState = 'offline';
    botError = /token/i.test(e.message) ? '유효하지 않은 봇 토큰입니다.' : e.message;
    try { await c.destroy(); } catch (_) { /* 무시 */ }
    throw new Error(botError);
  }
}

async function stopBot() {
  if (client) {
    const c = client;
    client = null;
    botState = 'offline';
    await c.destroy();
  }
  botState = 'offline';
}

function needGuild(id) {
  if (!client || botState !== 'online') throw new Error('봇이 실행 중이 아닙니다. 먼저 봇을 시작하세요.');
  const g = client.guilds.cache.get(id);
  if (!g) throw new Error('봇이 해당 서버에 없습니다.');
  return g;
}

async function sendPanel(gid) {
  const guild = needGuild(gid);
  const cfg = getCfg(gid);
  if (!cfg.roleId) throw new Error('인증 역할을 먼저 선택하고 저장하세요.');
  if (!cfg.channelId) throw new Error('인증 채널을 먼저 선택하고 저장하세요.');
  const ch = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) throw new Error('인증 채널을 찾을 수 없습니다.');
  const embed = new EmbedBuilder().setTitle(cfg.title).setDescription(cfg.description).setColor(cfg.color);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('v:start').setLabel(cfg.buttonLabel).setStyle(ButtonStyle.Success),
  );
  const payload = { embeds: [embed], components: [row] };
  if (cfg.messageId) {
    try {
      const old = await ch.messages.fetch(cfg.messageId);
      await old.edit(payload);
      return '기존 인증 메시지를 수정했습니다.';
    } catch (_) { /* 새로 전송 */ }
  }
  const m = await ch.send(payload);
  db.guilds[gid] = { ...cfg, messageId: m.id };
  saveDb();
  return '인증 메시지를 전송했습니다.';
}

// ───────────────────────── 웹 패널 ─────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

const webSessions = new Map(); // sid -> expires
const loginFails = new Map(); // ip -> { count, until }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}

function isAuthed(req) {
  const exp = webSessions.get(cookies(req).sid);
  return !!exp && exp > Date.now();
}

function auth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: '로그인이 필요합니다.' });
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

app.get('/', (req, res) => res.type('html').send(PANEL_HTML));

app.get('/api/me', (req, res) => res.json({ loggedIn: isAuthed(req) }));

app.post('/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Railway Variables에 ADMIN_PASSWORD를 먼저 설정하세요.' });
  }
  const f = loginFails.get(req.ip) || { count: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).json({ error: '로그인 시도 횟수 초과. 10분 뒤 다시 시도하세요.' });
  if (!crypto.timingSafeEqual(sha(req.body.password || ''), sha(ADMIN_PASSWORD))) {
    f.count++;
    if (f.count >= 5) { f.until = Date.now() + 10 * 60000; f.count = 0; }
    loginFails.set(req.ip, f);
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }
  loginFails.delete(req.ip);
  const sid = crypto.randomBytes(32).toString('hex');
  webSessions.set(sid, Date.now() + 7 * 86400000);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${req.secure ? '; Secure' : ''}`);
  return res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  webSessions.delete(cookies(req).sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/status', auth, (req, res) => {
  const online = client && botState === 'online';
  res.json({
    state: botState,
    error: botError,
    hasToken: !!db.token,
    autoStart: db.autoStart,
    tag: online ? client.user.tag : '',
    invite: online
      ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=268520448`
      : '',
    guilds: online ? client.guilds.cache.map((g) => ({ id: g.id, name: g.name })) : [],
  });
});

app.post('/api/token', auth, wrap(async (req, res) => {
  const token = String(req.body.token || '').trim();
  if (token) {
    if (token.length < 30) throw new Error('토큰 형식이 올바르지 않습니다.');
    db.token = token;
  }
  db.autoStart = !!req.body.autoStart;
  saveDb();
  res.json({ ok: true });
}));

app.post('/api/bot/:action', auth, wrap(async (req, res) => {
  const a = req.params.action;
  if (a === 'start') await startBot();
  else if (a === 'stop') await stopBot();
  else if (a === 'restart') { await stopBot(); await startBot(); }
  else throw new Error('알 수 없는 동작입니다.');
  res.json({ ok: true });
}));

app.get('/api/guild/:id', auth, wrap(async (req, res) => {
  const g = needGuild(req.params.id);
  const channels = g.channels.cache
    .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name }));
  const roles = g.roles.cache
    .filter((r) => r.id !== g.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, editable: r.editable }));
  res.json({ config: getCfg(g.id), channels, roles });
}));

function sanitize(b, old) {
  const str = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
  const num = (v, min, max, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const id = (v) => {
    const s = str(v, 25);
    if (s && !/^\d{5,25}$/.test(s)) throw new Error('잘못된 ID 값이 있습니다.');
    return s;
  };
  const mode = ['button', 'emoji', 'captcha'].includes(b.mode) ? b.mode : 'button';
  const rawEmojis = Array.isArray(b.emojis) ? b.emojis : String(b.emojis || '').split(/[\s,]+/);
  const emojis = [...new Set(rawEmojis.map((e) => String(e).trim()).filter(Boolean))].slice(0, 20);
  for (const e of emojis) {
    if (!/^<a?:\w+:\d+>$/.test(e) && !/\p{Extended_Pictographic}/u.test(e)) {
      throw new Error(`이모지가 아닌 값이 있습니다: ${e}`);
    }
  }
  if (mode === 'emoji' && emojis.length < 4) throw new Error('이모지 인증은 이모지를 4개 이상 입력해야 합니다.');
  const title = str(b.title, 256);
  const description = str(b.description, 2000);
  const buttonLabel = str(b.buttonLabel, 80);
  if (!title || !description || !buttonLabel) throw new Error('제목, 설명, 버튼 문구는 비워둘 수 없습니다.');
  return {
    ...old,
    mode,
    roleId: id(b.roleId),
    removeRoleId: id(b.removeRoleId),
    channelId: id(b.channelId),
    logChannelId: id(b.logChannelId),
    welcomeChannelId: id(b.welcomeChannelId),
    welcomeMessage: str(b.welcomeMessage, 1000) || DEFAULT_CFG.welcomeMessage,
    title, description, buttonLabel,
    color: /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#5865F2',
    emojis: emojis.length ? emojis : DEFAULT_CFG.emojis,
    captchaLength: num(b.captchaLength, 4, 8, 5),
    maxAttempts: num(b.maxAttempts, 1, 10, 3),
    lockMinutes: num(b.lockMinutes, 1, 1440, 5),
    timeoutSeconds: num(b.timeoutSeconds, 30, 600, 120),
  };
}

app.post('/api/guild/:id', auth, wrap(async (req, res) => {
  const g = needGuild(req.params.id);
  const cfg = sanitize(req.body, getCfg(g.id));
  if (cfg.roleId && !g.roles.cache.has(cfg.roleId)) throw new Error('선택한 인증 역할이 서버에 없습니다.');
  if (cfg.channelId && !g.channels.cache.has(cfg.channelId)) throw new Error('선택한 인증 채널이 서버에 없습니다.');
  db.guilds[g.id] = cfg;
  saveDb();
  res.json({ ok: true });
}));

app.post('/api/guild/:id/send', auth, wrap(async (req, res) => {
  const message = await sendPanel(req.params.id);
  res.json({ ok: true, message });
}));

// ───────────────────────── 시작 ─────────────────────────
loadDb();
charge.setup(app, {
  auth,
  wrap,
  dataDir: DATA_DIR,
  getClient: () => client,
  isOnline: () => !!client && botState === 'online',
});
if (!ADMIN_PASSWORD) console.warn('⚠️ ADMIN_PASSWORD 환경변수가 없습니다. Railway Variables에서 설정하세요.');

app.listen(PORT, () => {
  console.log(`웹 패널 실행 중: 포트 ${PORT}`);
  if (db.token && db.autoStart) {
    startBot().catch((e) => console.error('자동 시작 실패:', e.message));
  }
});

async function shutdown() {
  try { await stopBot(); } catch (_) { /* 무시 */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('처리되지 않은 거부:', e));

// ═════════ 웹 패널 HTML ═════════
const PANEL_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>인증 봇 패널</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font-family: -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; background: #1e1f22; color: #f2f3f5; }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 4px 0 16px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  .card { background: #2b2d31; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  label { display: block; font-size: 13px; color: #b5bac1; margin: 12px 0 4px; }
  input[type=text], input[type=password], input[type=number], textarea, select {
    width: 100%; padding: 11px; font-size: 16px; color: #f2f3f5; background: #1e1f22;
    border: 1px solid #3f4147; border-radius: 8px; font-family: inherit;
  }
  textarea { min-height: 80px; resize: vertical; }
  input[type=color] { width: 100%; height: 44px; border: 1px solid #3f4147; border-radius: 8px; background: #1e1f22; padding: 2px; }
  button { padding: 11px 14px; font-size: 15px; border: 0; border-radius: 8px; color: #fff; background: #5865f2; cursor: pointer; font-family: inherit; }
  button.green { background: #248046; }
  button.red { background: #da373c; }
  button.gray { background: #4e5058; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .row > button { flex: 1; min-width: 90px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .hidden { display: none !important; }
  .muted { color: #b5bac1; font-size: 13px; margin-top: 6px; word-break: break-all; }
  .err { color: #f23f42; font-size: 13px; margin-top: 6px; }
  .modes { display: grid; gap: 8px; }
  .mode { display: flex; align-items: center; gap: 10px; padding: 12px; background: #1e1f22; border: 1px solid #3f4147; border-radius: 8px; margin: 0; color: #f2f3f5; font-size: 15px; }
  .mode input { width: 18px; height: 18px; }
  .check { display: flex; align-items: center; gap: 8px; color: #f2f3f5; font-size: 14px; }
  .check input { width: 18px; height: 18px; }
  #toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #111214; color: #fff; padding: 12px 18px; border-radius: 10px; font-size: 14px; max-width: 90%; opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 10; }
  #toast.show { opacity: 1; }
  #toast.bad { background: #da373c; }
  a { color: #00a8fc; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🔐 인증 봇 패널</h1>

  <div id="login" class="card hidden">
    <h2>로그인</h2>
    <label for="pw">관리자 비밀번호</label>
    <input id="pw" type="password" autocomplete="current-password">
    <div class="row"><button onclick="login()">로그인</button></div>
  </div>

  <div id="app" class="hidden">
    <div class="card">
      <h2>🤖 봇 호스팅</h2>
      <div id="state">확인 중...</div>
      <div id="berr" class="err"></div>
      <label for="token">봇 토큰</label>
      <input id="token" type="password" placeholder="새 토큰 입력 (변경할 때만)" autocomplete="off">
      <div id="tokenState" class="muted"></div>
      <label class="check" style="margin-top:12px"><input id="auto" type="checkbox"> 서버 시작 시 봇 자동 실행</label>
      <div class="row"><button class="gray" onclick="saveToken()">토큰/설정 저장</button></div>
      <div class="row">
        <button class="green" onclick="botAct('start')">시작</button>
        <button class="red" onclick="botAct('stop')">중지</button>
        <button onclick="botAct('restart')">재시작</button>
      </div>
      <div id="inviteBox" class="muted hidden">봇 초대 링크: <a id="invite" href="#" target="_blank" rel="noopener">여기를 눌러 서버에 초대</a></div>
    </div>

    <div class="card">
      <h2>⚙️ 서버 인증 설정</h2>
      <label for="guild">서버 선택</label>
      <select id="guild" onchange="loadGuild()"></select>
      <div id="guildHint" class="muted">봇을 시작하고 서버에 초대하면 목록이 나타납니다.</div>

      <div id="form" class="hidden">
        <label>인증 방식</label>
        <div class="modes">
          <label class="mode"><input type="radio" name="mode" value="button" onchange="modeChanged()"> 🔘 버튼 인증 (버튼만 누르면 완료)</label>
          <label class="mode"><input type="radio" name="mode" value="emoji" onchange="modeChanged()"> 😀 이모지 인증 (같은 이모지 선택)</label>
          <label class="mode"><input type="radio" name="mode" value="captcha" onchange="modeChanged()"> 🖼️ 캡챠 인증 (이미지 코드 입력)</label>
        </div>

        <label for="roleId">인증 완료 시 지급할 역할 (필수)</label>
        <select id="roleId"></select>
        <label for="removeRoleId">인증 완료 시 제거할 역할 (선택)</label>
        <select id="removeRoleId"></select>
        <label for="channelId">인증 메시지를 보낼 채널 (필수)</label>
        <select id="channelId"></select>
        <label for="logChannelId">인증 로그 채널 (선택)</label>
        <select id="logChannelId"></select>
        <label for="welcomeChannelId">인증 완료 환영 메시지 채널 (선택)</label>
        <select id="welcomeChannelId"></select>
        <label for="welcomeMessage">환영 메시지 내용</label>
        <textarea id="welcomeMessage" maxlength="1000"></textarea>
        <div class="muted">사용 가능: {멘션} {유저} {서버} {인원}</div>

        <label for="title">인증 메시지 제목</label>
        <input id="title" type="text" maxlength="256">
        <label for="description">인증 메시지 설명</label>
        <textarea id="description" maxlength="2000"></textarea>
        <div class="grid2">
          <div><label for="buttonLabel">버튼 문구</label><input id="buttonLabel" type="text" maxlength="80"></div>
          <div><label for="color">임베드 색상</label><input id="color" type="color" value="#5865f2"></div>
        </div>

        <div id="emojiBox" class="hidden">
          <label for="emojis">이모지 목록 (공백으로 구분, 4개 이상)</label>
          <input id="emojis" type="text">
        </div>
        <div id="capBox" class="hidden">
          <label for="captchaLength">캡챠 글자 수 (4~8)</label>
          <input id="captchaLength" type="number" min="4" max="8">
        </div>

        <div id="failBox">
          <div class="grid2">
            <div><label for="maxAttempts">최대 실패 횟수</label><input id="maxAttempts" type="number" min="1" max="10"></div>
            <div><label for="lockMinutes">잠금 시간(분)</label><input id="lockMinutes" type="number" min="1" max="1440"></div>
          </div>
          <label for="timeoutSeconds">인증 제한 시간(초)</label>
          <input id="timeoutSeconds" type="number" min="30" max="600">
        </div>
        <div class="muted">※ 실패 설정은 이모지/캡챠 인증에 적용됩니다.</div>

        <div class="row">
          <button class="gray" onclick="saveGuild(false)">저장</button>
          <button class="green" onclick="saveGuild(true)">저장 + 인증 메시지 전송</button>
        </div>
      </div>
    </div>

    <div class="row"><button class="green" onclick="location.href='/charge'">💰 자충 자판기 설정</button></div>
    <div class="row"><button class="gray" onclick="logout()">로그아웃</button></div>
  </div>
</div>
<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let inited = false;
let guildSig = '';
let timer = null;

function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.className = ''; }, 2800);
}

async function api(path, method, body) {
  const r = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error(d.error || '로그인이 필요합니다.'); }
  if (!r.ok) throw new Error(d.error || '요청에 실패했습니다.');
  return d;
}

function showLogin() {
  clearInterval(timer);
  inited = false;
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 5000);
}

async function login() {
  try {
    await api('/api/login', 'POST', { password: $('pw').value });
    $('pw').value = '';
    showApp();
  } catch (e) { toast(e.message, true); }
}

async function logout() {
  await api('/api/logout', 'POST').catch(() => {});
  showLogin();
}

async function refresh() {
  try {
    const s = await api('/api/status');
    const map = { online: '🟢 온라인', starting: '🟡 시작 중...', offline: '🔴 오프라인' };
    $('state').textContent = (map[s.state] || s.state) + (s.tag ? ' · ' + s.tag : '');
    $('berr').textContent = s.error || '';
    $('tokenState').textContent = s.hasToken ? '저장된 토큰이 있습니다. (보안상 표시되지 않음)' : '저장된 토큰이 없습니다.';
    if (!inited) { $('auto').checked = s.autoStart; inited = true; }
    if (s.invite) { $('invite').href = s.invite; $('inviteBox').classList.remove('hidden'); }
    else $('inviteBox').classList.add('hidden');

    const sig = JSON.stringify(s.guilds);
    if (sig !== guildSig) {
      guildSig = sig;
      const sel = $('guild');
      const prev = sel.value;
      sel.innerHTML = '';
      s.guilds.forEach((g) => {
        const o = document.createElement('option');
        o.value = g.id;
        o.textContent = g.name;
        sel.appendChild(o);
      });
      if (s.guilds.some((g) => g.id === prev)) sel.value = prev;
      $('guildHint').classList.toggle('hidden', s.guilds.length > 0);
      $('form').classList.toggle('hidden', s.guilds.length === 0);
      if (s.guilds.length) loadGuild();
    }
  } catch (e) { /* 401은 로그인 화면으로 이동됨 */ }
}

async function saveToken() {
  try {
    await api('/api/token', 'POST', { token: $('token').value, autoStart: $('auto').checked });
    $('token').value = '';
    toast('저장되었습니다.');
    refresh();
  } catch (e) { toast(e.message, true); }
}

async function botAct(action) {
  try {
    toast('처리 중...');
    await api('/api/bot/' + action, 'POST');
    toast('완료되었습니다.');
  } catch (e) { toast(e.message, true); }
  refresh();
}

function fillSelect(sel, items, selected, emptyLabel) {
  sel.innerHTML = '';
  const e = document.createElement('option');
  e.value = '';
  e.textContent = emptyLabel;
  sel.appendChild(e);
  items.forEach((it) => {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = (it.name.length ? (sel.id.includes('hannel') ? '#' : '') : '') + it.name + (it.editable === false ? ' (⚠ 봇 역할보다 높음)' : '');
    sel.appendChild(o);
  });
  sel.value = selected || '';
}

function modeChanged() {
  const m = document.querySelector('input[name=mode]:checked').value;
  $('emojiBox').classList.toggle('hidden', m !== 'emoji');
  $('capBox').classList.toggle('hidden', m !== 'captcha');
  $('failBox').classList.toggle('hidden', m === 'button');
}

async function loadGuild() {
  const id = $('guild').value;
  if (!id) return;
  try {
    const d = await api('/api/guild/' + id);
    const c = d.config;
    fillSelect($('roleId'), d.roles, c.roleId, '역할 선택');
    fillSelect($('removeRoleId'), d.roles, c.removeRoleId, '사용 안 함');
    fillSelect($('channelId'), d.channels, c.channelId, '채널 선택');
    fillSelect($('logChannelId'), d.channels, c.logChannelId, '사용 안 함');
    fillSelect($('welcomeChannelId'), d.channels, c.welcomeChannelId, '사용 안 함');
    $('welcomeMessage').value = c.welcomeMessage;
    document.querySelector('input[name=mode][value=' + c.mode + ']').checked = true;
    $('title').value = c.title;
    $('description').value = c.description;
    $('buttonLabel').value = c.buttonLabel;
    $('color').value = c.color;
    $('emojis').value = c.emojis.join(' ');
    $('captchaLength').value = c.captchaLength;
    $('maxAttempts').value = c.maxAttempts;
    $('lockMinutes').value = c.lockMinutes;
    $('timeoutSeconds').value = c.timeoutSeconds;
    modeChanged();
  } catch (e) { toast(e.message, true); }
}

function collect() {
  const v = (id) => $(id).value;
  return {
    mode: document.querySelector('input[name=mode]:checked').value,
    roleId: v('roleId'), removeRoleId: v('removeRoleId'),
    channelId: v('channelId'), logChannelId: v('logChannelId'),
    welcomeChannelId: v('welcomeChannelId'), welcomeMessage: v('welcomeMessage'),
    title: v('title'), description: v('description'),
    buttonLabel: v('buttonLabel'), color: v('color'), emojis: v('emojis'),
    captchaLength: v('captchaLength'), maxAttempts: v('maxAttempts'),
    lockMinutes: v('lockMinutes'), timeoutSeconds: v('timeoutSeconds'),
  };
}

async function saveGuild(send) {
  const id = $('guild').value;
  try {
    await api('/api/guild/' + id, 'POST', collect());
    if (send) {
      const r = await api('/api/guild/' + id + '/send', 'POST');
      toast('저장 완료 · ' + r.message);
    } else {
      toast('저장되었습니다.');
    }
  } catch (e) { toast(e.message, true); }
}

$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

(async () => {
  try {
    const me = await api('/api/me');
    if (me.loggedIn) showApp(); else showLogin();
  } catch (e) { showLogin(); }
})();
</script>
</body>
</html>
`;

const CHARGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>자충 자판기 패널</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font-family: -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; background: #1e1f22; color: #f2f3f5; }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 4px 0 16px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  .card { background: #2b2d31; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  label { display: block; font-size: 13px; color: #b5bac1; margin: 12px 0 4px; }
  input[type=text], input[type=number], textarea, select {
    width: 100%; padding: 11px; font-size: 16px; color: #f2f3f5; background: #1e1f22;
    border: 1px solid #3f4147; border-radius: 8px; font-family: inherit;
  }
  textarea { min-height: 70px; resize: vertical; }
  button { padding: 11px 14px; font-size: 15px; border: 0; border-radius: 8px; color: #fff; background: #5865f2; cursor: pointer; font-family: inherit; }
  button.green { background: #248046; }
  button.red { background: #da373c; }
  button.gray { background: #4e5058; }
  button.small { padding: 8px 10px; font-size: 13px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .row > button { flex: 1; min-width: 90px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .hidden { display: none !important; }
  .muted { color: #b5bac1; font-size: 13px; margin-top: 6px; word-break: break-all; line-height: 1.5; }
  .check { display: flex; align-items: center; gap: 8px; color: #f2f3f5; font-size: 15px; margin: 12px 0 0; }
  .check input { width: 18px; height: 18px; }
  .item { background: #1e1f22; border-radius: 8px; padding: 10px; margin-top: 8px; font-size: 14px; line-height: 1.5; word-break: break-all; white-space: pre-line; }
  .item .btns { display: flex; gap: 6px; margin-top: 8px; }
  .code { background: #1e1f22; border-radius: 8px; padding: 10px; font-family: ui-monospace, Menlo, monospace; font-size: 13px; word-break: break-all; margin-top: 6px; }
  #toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #111214; color: #fff; padding: 12px 18px; border-radius: 10px; font-size: 14px; max-width: 90%; opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 10; }
  #toast.show { opacity: 1; }
  #toast.bad { background: #da373c; }
</style>
</head>
<body>
<div class="wrap">
  <h1>💰 자충 자판기 패널</h1>

  <div class="card">
    <div class="grid2">
      <div><label for="guild">서버</label><select id="guild" onchange="load()"></select></div>
      <div><label for="type">자판기 종류</label>
        <select id="type" onchange="load()"><option value="ios">iOS</option><option value="android">안드로이드</option></select>
      </div>
    </div>
    <div id="hint" class="muted hidden">봇이 꺼져 있거나 서버가 없습니다. 메인 패널에서 봇을 시작하세요.</div>
    <div class="row"><button class="gray" onclick="location.href='/'">← 메인 패널</button></div>
  </div>

  <div id="main" class="hidden">
    <div class="card">
      <h2>⚙️ 충전 설정</h2>
      <label class="check"><input id="enabled" type="checkbox"> 충전 기능 켜기 (꺼지면 신청/입금 처리 모두 중지)</label>
      <label class="check"><input id="auto" type="checkbox"> 입금 감지 시 자동 승인 (끄면 수동 승인)</label>

      <label for="bank">은행</label><input id="bank" type="text" maxlength="30">
      <label for="number">계좌번호</label><input id="number" type="text" maxlength="40">
      <label for="holder">예금주</label><input id="holder" type="text" maxlength="30">
      <div class="grid2">
        <div><label for="minAmount">최소 금액</label><input id="minAmount" type="number"></div>
        <div><label for="maxAmount">최대 금액</label><input id="maxAmount" type="number"></div>
      </div>
      <label for="expireMinutes">신청 유효 시간(분)</label><input id="expireMinutes" type="number">
      <label for="channelId">충전 패널 채널</label><select id="channelId"></select>
      <label for="logChannelId">충전 로그 채널 (선택)</label><select id="logChannelId"></select>
      <label for="shopChannelId">상점 패널 채널</label><select id="shopChannelId"></select>
      <label for="buyLogChannelId">구매 로그 채널 (선택)</label><select id="buyLogChannelId"></select>
      <label for="reviewChannelId">구매후기 채널 (선택, 비우면 후기 기능 꺼짐)</label><select id="reviewChannelId"></select>
      <label for="title">패널 제목</label><input id="title" type="text" maxlength="256">
      <label for="desc">패널 설명</label><textarea id="desc" maxlength="2000"></textarea>
      <div class="row">
        <button class="gray" onclick="saveCfg(false)">저장</button>
        <button class="green" onclick="saveCfg(true)">저장 + 패널 전송</button>
      </div>
    </div>

    <div class="card">
      <h2>📲 입금 문자 연동 (웹훅)</h2>
      <div class="muted">웹훅 주소 (POST)</div>
      <div id="whUrl" class="code"></div>
      <div class="muted">키</div>
      <div id="whKey" class="code"></div>
      <div class="row">
        <button class="gray small" onclick="copy('whUrl')">주소 복사</button>
        <button class="gray small" onclick="copy('whKey')">키 복사</button>
        <button class="red small" onclick="regenKey()">키 재발급</button>
      </div>
      <div class="muted">
        본문(JSON): {"key":"위 키","text":"입금 문자 내용"}<br>
        • 아이폰: 단축어 → 자동화 → 메시지(내용에 "입금" 포함) → "URL 콘텐츠 가져오기"(POST, JSON, key/text 필드, text는 단축어 입력) → "실행 전에 묻기" 끄기<br>
        • 안드로이드: SMS 전달 앱(웹훅 지원)에서 위 주소로 POST, 본문에 문자 내용 변수 사용<br>
        • 은행의 입금 문자 알림 서비스가 켜져 있어야 하고, 문자에 입금자명과 금액이 포함돼야 해요.
      </div>
    </div>

    <div class="card">
      <h2>⏳ 충전 요청</h2>
      <div id="openList"></div>
      <div id="openEmpty" class="muted">대기 중인 요청이 없습니다.</div>
    </div>

    <div class="card">
      <h2>🛒 상품 관리</h2>
      <div id="prodList"></div>
      <label for="pName">상품명</label><input id="pName" type="text" maxlength="50">
      <div class="grid2">
        <div><label for="pPrice">가격(원)</label><input id="pPrice" type="text" inputmode="numeric"></div>
        <div><label for="pDesc">짧은 설명</label><input id="pDesc" type="text" maxlength="100"></div>
      </div>
      <div class="row"><button class="green" onclick="addProduct()">상품 추가</button></div>
      <label for="stockProd">재고를 추가할 상품</label><select id="stockProd"></select>
      <label for="stockItems">재고 내용 (한 줄에 하나, 구매 시 1줄씩 지급)</label><textarea id="stockItems"></textarea>
      <div class="row">
        <button class="green" onclick="addStock()">재고 추가</button>
        <button class="gray" onclick="sendShop()">저장 + 상점 패널 전송</button>
      </div>
      <h2 style="margin-top:16px">🧾 최근 구매</h2>
      <div id="buyList"></div>
    </div>

    <div class="card">
      <h2>🛠️ 수동 충전 / 차감</h2>
      <label for="adjUser">유저 ID</label><input id="adjUser" type="text" inputmode="numeric">
      <label for="adjAmount">금액 (충전은 양수, 차감은 음수)</label><input id="adjAmount" type="text" inputmode="numeric">
      <div class="row"><button class="green" onclick="adjust()">적용</button></div>
    </div>

    <div class="card">
      <h2>🏆 잔액 랭킹</h2>
      <div id="rank"></div>
      <h2 style="margin-top:16px">🧾 최근 충전 내역</h2>
      <div id="recent"></div>
    </div>
  </div>
</div>
<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let G = '', T = 'ios', DATA = null;

function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.className = ''; }, 2800);
}

async function api(path, method, body) {
  const r = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/'; throw new Error('로그인이 필요합니다.'); }
  if (!r.ok) throw new Error(d.error || '요청에 실패했습니다.');
  return d;
}

const won = (n) => Number(n).toLocaleString('ko-KR') + '원';
const when = (t) => new Date(t).toLocaleString('ko-KR');

function fillSelect(sel, items, selected, emptyLabel) {
  sel.innerHTML = '';
  const e = document.createElement('option');
  e.value = '';
  e.textContent = emptyLabel;
  sel.appendChild(e);
  items.forEach((it) => {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = '#' + it.name;
    sel.appendChild(o);
  });
  sel.value = selected || '';
}

function item(text, buttons) {
  const d = document.createElement('div');
  d.className = 'item';
  const p = document.createElement('div');
  p.textContent = text;
  d.appendChild(p);
  if (buttons) {
    const b = document.createElement('div');
    b.className = 'btns';
    buttons.forEach(([label, cls, fn]) => {
      const x = document.createElement('button');
      x.className = 'small ' + cls;
      x.textContent = label;
      x.onclick = fn;
      b.appendChild(x);
    });
    d.appendChild(b);
  }
  return d;
}

async function init() {
  try {
    const s = await api('/api/status');
    const sel = $('guild');
    sel.innerHTML = '';
    s.guilds.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.name;
      sel.appendChild(o);
    });
    if (!s.guilds.length) { $('hint').classList.remove('hidden'); return; }
    load();
  } catch (e) { toast(e.message, true); }
}

async function load() {
  G = $('guild').value;
  T = $('type').value;
  if (!G) return;
  try {
    DATA = await api(\`/api/charge/\${G}/\${T}\`);
    render();
  } catch (e) { toast(e.message, true); }
}

function render() {
  const c = DATA.config;
  $('main').classList.remove('hidden');
  $('enabled').checked = c.enabled;
  $('auto').checked = c.auto;
  ['bank', 'number', 'holder', 'minAmount', 'maxAmount', 'expireMinutes', 'title', 'desc'].forEach((k) => { $(k).value = c[k]; });
  fillSelect($('channelId'), DATA.channels, c.channelId, '채널 선택');
  fillSelect($('logChannelId'), DATA.channels, c.logChannelId, '사용 안 함');
  fillSelect($('shopChannelId'), DATA.channels, c.shopChannelId, '채널 선택');
  fillSelect($('buyLogChannelId'), DATA.channels, c.buyLogChannelId, '사용 안 함');
  fillSelect($('reviewChannelId'), DATA.channels, c.reviewChannelId, '사용 안 함');
  renderShop();
  $('whUrl').textContent = \`\${location.origin}/api/deposit/\${G}/\${T}\`;
  $('whKey').textContent = c.key;

  const ol = $('openList');
  ol.innerHTML = '';
  $('openEmpty').classList.toggle('hidden', DATA.open.length > 0);
  DATA.open.forEach((r) => {
    const st = r.status === 'expired' ? '⌛ 만료' : (r.deposited ? '✅ 입금확인' : '⏳ 대기');
    ol.appendChild(item(
      \`\${st} · \${r.name} · \${won(r.amount)}\\n유저 \${r.userId} · \${when(r.createdAt)}\`,
      [['승인', 'green', () => act('approve', r.id)], ['취소', 'red', () => act('cancel', r.id)]],
    ));
  });

  const rk = $('rank');
  rk.innerHTML = '';
  if (!DATA.ranking.length) rk.appendChild(item('잔액 보유 유저가 없습니다.'));
  DATA.ranking.forEach((x, n) => rk.appendChild(item(\`\${n + 1}. \${x.userId} · \${won(x.balance)}\`)));

  const rc = $('recent');
  rc.innerHTML = '';
  if (!DATA.recent.length) rc.appendChild(item('내역이 없습니다.'));
  DATA.recent.forEach((r) => {
    const via = { auto: '자동', manual: '수동', admin: '관리자' }[r.via] || r.via;
    rc.appendChild(item(\`\${r.amount > 0 ? '+' : ''}\${won(r.amount)} · \${via} · 유저 \${r.userId} · \${when(r.doneAt || r.createdAt)}\`));
  });
}

const base = () => '/api/charge/' + G + '/' + T;

function renderShop() {
  const pl = $('prodList');
  pl.innerHTML = '';
  const sel = $('stockProd');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!DATA.products.length) pl.appendChild(item('등록된 상품이 없습니다.'));
  DATA.products.forEach((p) => {
    pl.appendChild(item(
      p.name + ' · ' + won(p.price) + ' · 재고 ' + p.stock + (p.desc ? '\\n' + p.desc : ''),
      [['삭제', 'red', () => delProduct(p.id)]],
    ));
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });
  if (DATA.products.some((p) => p.id === prev)) sel.value = prev;
  const bl = $('buyList');
  bl.innerHTML = '';
  if (!DATA.purchases.length) bl.appendChild(item('구매 내역이 없습니다.'));
  DATA.purchases.forEach((x) => bl.appendChild(item(
    x.productName + ' · ' + won(x.price) + ' · 유저 ' + x.userId + ' · ' + when(x.at) + (x.reviewed ? ' · ⭐후기' : ''),
  )));
}

async function addProduct() {
  try {
    await api(base() + '/products', 'POST', { name: $('pName').value, price: $('pPrice').value, desc: $('pDesc').value });
    ['pName', 'pPrice', 'pDesc'].forEach((k) => { $(k).value = ''; });
    toast('상품이 추가되었습니다.');
    load();
  } catch (e) { toast(e.message, true); }
}

async function addStock() {
  try {
    const r = await api(base() + '/products/stock', 'POST', { id: $('stockProd').value, items: $('stockItems').value });
    $('stockItems').value = '';
    toast('재고가 추가되었습니다. (현재 ' + r.stock + '개)');
    load();
  } catch (e) { toast(e.message, true); }
}

async function delProduct(id) {
  if (!confirm('상품과 남은 재고를 삭제할까요?')) return;
  try {
    await api(base() + '/products/delete', 'POST', { id });
    toast('삭제되었습니다.');
    load();
  } catch (e) { toast(e.message, true); }
}

async function sendShop() {
  try {
    await api(base() + '/config', 'POST', collect());
    const r = await api(base() + '/shop/panel', 'POST');
    toast('저장 완료 · ' + r.message);
    load();
  } catch (e) { toast(e.message, true); }
}

function collect() {
  const v = (id) => $(id).value;
  return {
    enabled: $('enabled').checked, auto: $('auto').checked,
    bank: v('bank'), number: v('number'), holder: v('holder'),
    minAmount: v('minAmount'), maxAmount: v('maxAmount'), expireMinutes: v('expireMinutes'),
    channelId: v('channelId'), logChannelId: v('logChannelId'),
    shopChannelId: v('shopChannelId'), buyLogChannelId: v('buyLogChannelId'), reviewChannelId: v('reviewChannelId'),
    title: v('title'), desc: v('desc'),
  };
}

async function saveCfg(send) {
  try {
    await api(\`/api/charge/\${G}/\${T}/config\`, 'POST', collect());
    if (send) {
      const r = await api(\`/api/charge/\${G}/\${T}/panel\`, 'POST');
      toast('저장 완료 · ' + r.message);
    } else toast('저장되었습니다.');
    load();
  } catch (e) { toast(e.message, true); }
}

async function act(kind, id) {
  try {
    await api(\`/api/charge/\${G}/\${T}/\${kind}\`, 'POST', { id });
    toast(kind === 'approve' ? '승인되었습니다.' : '취소되었습니다.');
    load();
  } catch (e) { toast(e.message, true); }
}

async function adjust() {
  try {
    const r = await api(\`/api/charge/\${G}/\${T}/adjust\`, 'POST', { userId: $('adjUser').value, amount: $('adjAmount').value });
    toast('적용 완료 · 현재 잔액 ' + won(r.balance));
    $('adjAmount').value = '';
    load();
  } catch (e) { toast(e.message, true); }
}

async function regenKey() {
  if (!confirm('키를 재발급하면 기존 연동(단축어/문자 앱)의 키를 모두 바꿔야 합니다. 계속할까요?')) return;
  try {
    await api(\`/api/charge/\${G}/\${T}/key\`, 'POST');
    toast('키가 재발급되었습니다.');
    load();
  } catch (e) { toast(e.message, true); }
}

async function copy(id) {
  try {
    await navigator.clipboard.writeText($(id).textContent);
    toast('복사되었습니다.');
  } catch (e) { toast('복사에 실패했습니다. 길게 눌러 직접 복사하세요.', true); }
}

init();
</script>
</body>
</html>
`;
