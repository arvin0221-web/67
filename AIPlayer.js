// AIPlayer.js
import Groq from 'groq-sdk';
import { ROLES, ROLE_NAMES, TEAM } from './constants.js';

let groqClient = null;

function getClient() {
  if (!groqClient && process.env.GROQ_API_KEY) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 建立遊戲情境 context（提供給所有 AI 決策用）
function buildContext(bot, game) {
  const alive = game.alivePlayers.map(p => `${p.number}號${p.displayName}`).join('、');
  const dead = [...game.players.values()]
    .filter(p => !p.alive)
    .map(p => `${p.number}號${p.displayName}（${ROLE_NAMES[p.role]}）`)
    .join('、') || '無';

  const isWolf = bot.role === ROLES.WEREWOLF;
  const wolfAllies = isWolf
    ? game.aliveWolves.filter(p => p.id !== bot.id).map(p => `${p.number}號${p.displayName}`).join('、') || '無'
    : null;

  const roleLabel = {
    [ROLES.WEREWOLF]: '狼人',
    [ROLES.SEER]: '預言家',
    [ROLES.WITCH]: '女巫',
    [ROLES.HUNTER]: '獵人',
    [ROLES.VILLAGER]: '平民',
  }[bot.role] || '平民';

  return {
    day: game.day,
    myNumber: bot.number,
    myName: bot.displayName,
    myRole: roleLabel,
    isWolf,
    wolfAllies,
    alivePlayers: alive,
    deadPlayers: dead,
    roleLabel,
  };
}

// 核心 Groq 呼叫
async function callGroq(systemPrompt, userPrompt, maxTokens = 300) {
  const client = getClient();
  if (!client) return null;
  try {
    const res = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: maxTokens,
      temperature: 0.85,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim() ?? null;
    console.log('[AI] Groq 回應:', text?.slice(0, 80) ?? 'NULL');
    return text;
  } catch (e) {
    console.warn('[AI] Groq 呼叫失敗:', e.message?.slice(0, 120));
    return null;
  }
}

// 從回應中解析 JSON
function parseJSON(text) {
  if (!text) return null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (_) {}
  return null;
}

// 從回應中取出公開發言，移除所有思考標籤
function extractSpeech(text) {
  if (!text) return null;

  // 1. 找 <speech>...</speech>
  const speechTag = text.match(/<speech>([\s\S]*?)<\/speech>/i);
  if (speechTag) return speechTag[1].trim().replace(/^["「『]|["」』]$/g, '').trim();

  // 2. 移除 <thinking>...</thinking>，取剩餘文字
  let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();

  // 3. 移除殘留的標籤文字（如 "<speech> 公開發言："）
  cleaned = cleaned.replace(/<\/?(?:thinking|speech)>/gi, '').trim();
  cleaned = cleaned.replace(/^(?:公開發言|speech|thinking)\s*[:：]?\s*/i, '').trim();
  cleaned = cleaned.replace(/^["「『]|["」』]$/g, '').trim();

  if (cleaned.length > 5) return cleaned.slice(0, 150);
  return null;
}

// ── 白天發言（雙層思維）──────────────────────────────────

export async function aiDaySpeak(bot, game, discussionHistory) {
  const ctx = buildContext(bot, game);
  // 本輪發言
  const history = discussionHistory.length > 0
    ? discussionHistory.map((h, i) => `[${i + 1}] ${h.name}：${h.content}`).join('\n')
    : '（本輪尚無發言）';

  // 歷史發言記錄（跨天）
  const allHistory = game.allDiscussionHistory || [];
  const historyByDay = allHistory.length > 0
    ? allHistory.map(d => `【第${d.day}天發言記錄】\n${d.speeches.map(h => `${h.name}：${h.content}`).join('\n')}`).join('\n\n')
    : '（無歷史記錄）';

  const systemPrompt = ctx.isWolf
    ? `你是一個狼人殺遊戲的AI玩家，你的真實身份是【狼人】，但你絕對不能說出來。
你必須100%偽裝成好人，任何情況下都不能承認或暗示自己是狼人。
你的目標是保護狼人同伴、引導好人互相懷疑、讓好人被投票放逐。

你可以用的策略（在thinking裡選擇，speech裡執行）：
- 穿衣服：裝平民，低調附和別人，不主動出風頭
- 悍跳預言家：主動說「我是預言家，我查了X號是狼人（或好人）」來誤導
- 倒鉤：先裝好人分析，再把矛頭指向真正的好人
- 帶節奏：讓大家懷疑某個對狼人威脅最大的好人

<thinking> 裡可以說真實想法和策略（不公開）。
<speech> 是你對其他玩家說的話，必須像一個真正的好人在發言，絕對不能說「我是狼人」或任何暗示。

<speech> 格式要求：
- 自然口語，像真人聊天，不能有編號列點
- 內容完整但簡潔，不超過80字
- 繁體中文，可用術語：金水、銀水、查殺、對跳、悍跳`
    : ctx.myRole === '預言家'
    ? `你是狼人殺的【預言家】。每晚可查驗一名玩家陣營。
策略：
- 有查驗結果就報出來（金水/查殺），沒有就說你在觀察
- 若有人跳預言家，強勢對跳並列出你的查驗鏈
- 第二天起可以分析其他人之前發言是否有邏輯破綻

發言原則：
- 有資訊就報資訊，沒資訊就說「我目前沒有特別的線索，先觀察」，不要硬分析
- 不要說廢話或分析無意義的「我是平民」之類的話
- 自然口語，不能列點，80字以內，繁體中文`
    : ctx.myRole === '女巫'
    ? `你是狼人殺的【女巫】。有一瓶解藥（銀水）和一瓶毒藥各一次。
策略：
- 若昨晚用了解藥救了某人，今天可宣布銀水保護他
- 謹慎決定是否公開身份
- 第二天起可以分析其他人之前發言的邏輯漏洞

發言原則：
- 有資訊（銀水/毒藥線索）就說，沒資訊就說「我先觀察，目前沒特別看法」
- 不要硬分析無用資訊，不要列點，80字以內，繁體中文`
    : ctx.myRole === '獵人'
    ? `你是狼人殺的【獵人】。死亡時可帶走一名玩家。
策略：
- 通常第一天沒有特別資訊，直接說「我先觀察」即可
- 第二天起分析誰最可疑，死後帶走最可疑的人
- 可以威脅：「如果我死，我會帶走我最懷疑的人」

發言原則：
- 沒有明確線索就說「我還在觀察，沒有特別看法」
- 不要硬分析，不要列點，80字以內，繁體中文`
    : `你是狼人殺的【平民】。沒有特殊技能。
策略：
- 第一天沒有資訊，直接說「我是平民，沒有特別線索，先聽大家說」
- 第二天起根據昨天的發言，找出誰說話有邏輯漏洞或前後矛盾

發言原則：
- 沒有線索就承認沒有，不要硬分析「你說你是平民可能是真的也可能是假的」這種廢話
- 有懷疑對象就直接說誰可疑、為什麼
- 不要列點，80字以內，繁體中文`;

  // 女巫額外資訊：藥品狀態、救了誰、毒了誰
  let witchExtra = '';
  if (bot.role === ROLES.WITCH) {
    const saveStatus = game.witchSaveUsed ? '已使用' : '未使用';
    const poisonStatus = game.witchPoisonUsed ? '已使用' : '未使用';
    const savedTarget = game.witchSavedTarget
      ? game.getPlayer(game.witchSavedTarget)?.displayName || '某人'
      : null;
    const savedNote = savedTarget
      ? `我曾用解藥救了【${savedTarget}】，他是我的銀水，可以適時公開保護他。`
      : '';
    witchExtra = `\n【女巫藥品狀態】解藥：${saveStatus}｜毒藥：${poisonStatus}${savedNote ? '\n' + savedNote : ''}`;
  }

  // 平安夜記錄（讓狼人知道解藥用了幾次）
  const peacefulNights = game.peacefulNights || [];
  const peacefulNote = ctx.isWolf && game.witchSaveUsed
    ? `\n【重要】女巫的解藥已用完（第${peacefulNights.join('、')}天是平安夜），今後自刀無意義。`
    : '';

  const userPrompt = `【遊戲情境】
第${ctx.day}天白天 | 我是 ${ctx.myNumber}號${ctx.myName}（身份：${ctx.myRole}）
${ctx.isWolf ? `我的狼人同伴：${ctx.wolfAllies}` : ''}
存活玩家：${ctx.alivePlayers}
已死亡：${ctx.deadPlayers}${witchExtra}${peacefulNote}

【歷史發言記錄（供分析邏輯漏洞）】
${historyByDay}

【本輪討論記錄】
${history}

現在輪到我「${ctx.myName}」發言。
提醒：沒有資訊就直接說沒有，不要分析廢話。第二天起可以指出誰的發言有邏輯漏洞。
請先 <thinking> 分析，再 <speech> 輸出公開發言：`;

  const text = await callGroq(systemPrompt, userPrompt, 400);
  const speech = extractSpeech(text);
  if (speech) return speech; // 不強制截斷，讓AI自己控制長度

  // Fallback
  const fallbacks = ctx.isWolf
    ? ['我覺得需要仔細觀察大家的發言。', '目前沒有太明顯的線索，先聽聽大家說。', '我認同剛才的分析，我們要冷靜。']
    : ['我覺得要注意發言前後矛盾的人。', '大家有沒有注意到某些人說話很奇怪？', '我先聽聽大家的分析再表態。'];
  return randomChoice(fallbacks);
}

// ── 狼人選擇擊殺目標 ──────────────────────────────────

export async function aiWolfChooseTarget(bot, game) {
  const ctx = buildContext(bot, game);

  // 平安夜 = 女巫解藥已用，狼人知道，不能再自刀（自刀無意義）
  const witchSaveUsed = game.witchSaveUsed;
  // 如果解藥還沒用，可以考慮自刀讓女巫浪費解藥；解藥用了就不要自刀
  const canSelfKill = !witchSaveUsed;

  const allTargets = game.alivePlayers.filter(p => p.id !== bot.id);
  const goodTargets = allTargets.filter(p => p.team !== TEAM.WEREWOLF);
  // 若解藥已用，只殺好人；若解藥未用，也可以殺狼人同伴（讓女巫浪費解藥）
  const targets = canSelfKill ? allTargets : goodTargets;
  if (!targets.length) return null;

  const targetList = targets.map(p =>
    `${p.number}號${p.displayName}（${p.team === TEAM.WEREWOLF ? '狼人同伴' : '好人'}）`
  ).join('、');

  const witchNote = witchSaveUsed
    ? '女巫的解藥已經用完（曾有平安夜），不需要再考慮自刀。只殺好人。'
    : '女巫解藥尚未使用。可以考慮殺狼人同伴讓女巫浪費解藥，但通常不建議。';

  const systemPrompt = `你是狼人殺的狼人，現在要選擇今晚的擊殺目標。
優先順序：預言家 > 女巫 > 獵人 > 平民。
${witchNote}
只輸出一個數字（玩家編號），不加任何說明。`;

  const userPrompt = `我的狼人同伴：${ctx.wolfAllies}
可選目標：${targetList}
已死亡：${ctx.deadPlayers}
選擇今晚擊殺目標的編號：`;

  const text = await callGroq(systemPrompt, userPrompt, 5);
  if (text) {
    const num = parseInt(text.trim());
    if (targets.map(p => p.number).includes(num)) return num;
  }
  // Fallback：優先殺神職
  const specials = goodTargets.filter(p => [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER].includes(p.role));
  if (specials.length) return randomChoice(specials.map(p => p.number));
  return randomChoice(goodTargets.length ? goodTargets.map(p => p.number) : targets.map(p => p.number));
}

// ── 預言家選擇查驗目標 ────────────────────────────────

export async function aiSeerChooseTarget(bot, game, checked) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && !checked.has(p.id));
  if (!targets.length) return null;

  const ctx = buildContext(bot, game);
  const memo = [...checked.entries()].map(([id, t]) => {
    const p = game.getPlayer(id);
    return p ? `${p.number}號${p.displayName}=${t === TEAM.WEREWOLF ? '狼人' : '好人'}` : '';
  }).filter(Boolean).join('、') || '尚未查驗任何人';

  const systemPrompt = `你是狼人殺的預言家，每晚可查驗一名玩家的陣營。
策略：優先查驗最可疑的人，或還沒有任何資訊的人。
只輸出一個數字（玩家編號），不加任何說明。`;

  const userPrompt = `已查驗記錄：${memo}
未查驗的存活玩家：${targets.map(p => `${p.number}號${p.displayName}`).join('、')}
已死亡：${ctx.deadPlayers}
選擇今晚查驗目標的編號：`;

  const text = await callGroq(systemPrompt, userPrompt, 5);
  if (text) {
    const num = parseInt(text.trim());
    if (targets.map(p => p.number).includes(num)) return num;
  }
  return randomChoice(targets.map(p => p.number));
}

// ── 女巫決定是否救人 ──────────────────────────────────

export async function aiWitchDecideSave(bot, victim) {
  // 70% 機率救人（第一天100%救）
  return bot.game?.day === 1 ? true : Math.random() < 0.7;
}

// ── 女巫決定是否毒人 ──────────────────────────────────

export async function aiWitchDecidePoison(bot, game) {
  if (Math.random() > 0.35) return null; // 35% 機率毒人
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && p.team !== TEAM.WEREWOLF);
  if (!targets.length) return null;
  return randomChoice(targets.map(p => p.number));
}

// ── 投票（根據討論記錄分析）────────────────────────────

export async function aiVote(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;

  const ctx = buildContext(bot, game);
  const history = (game.discussionHistory || [])
    .map((h, i) => `[${i + 1}] ${h.name}：${h.content}`).join('\n') || '（無討論記錄）';

  if (ctx.isWolf) {
    const goodTargets = targets.filter(p => p.team !== TEAM.WEREWOLF);
    if (!goodTargets.length) return randomChoice(targets.map(p => p.number));

    const systemPrompt = `你是狼人殺的狼人，現在要投票放逐一名好人。
絕對不能投票給你的狼人同伴。
根據討論記錄，選一個最自然、最不會讓人懷疑你是狼人的投票對象。
只輸出一個數字（玩家編號），不加任何說明。`;

    const userPrompt = `我的狼人同伴：${ctx.wolfAllies}
存活玩家：${targets.map(p => `${p.number}號${p.displayName}（${p.team === TEAM.WEREWOLF ? '我的同伴' : '好人'}）`).join('、')}
討論記錄：\n${history}
已死亡：${ctx.deadPlayers}
選擇投票放逐的編號（只能選好人）：`;

    const text = await callGroq(systemPrompt, userPrompt, 5);
    if (text) {
      const num = parseInt(text.trim());
      if (goodTargets.map(p => p.number).includes(num)) return num;
    }
    return randomChoice(goodTargets.map(p => p.number));
  }

  // 好人陣營：用雙層思維分析
  const systemPrompt = `你是狼人殺的${ctx.roleLabel}，現在要投票放逐一名玩家。
根據白天討論，分析誰的發言最可疑、邏輯最矛盾、最像狼人。
注意：狼人會帶節奏、轉移矛頭、前後矛盾、對好人發查殺。
只輸出一個數字（玩家編號），不加任何說明。`;

  const userPrompt = `我是 ${ctx.myNumber}號${ctx.myName}（${ctx.roleLabel}）
存活玩家：${targets.map(p => `${p.number}號${p.displayName}`).join('、')}
討論記錄：\n${history}
已死亡：${ctx.deadPlayers}
根據以上分析，選擇最可疑的玩家投票放逐的編號：`;

  const text = await callGroq(systemPrompt, userPrompt, 5);
  if (text) {
    const num = parseInt(text.trim());
    if (targets.map(p => p.number).includes(num)) return num;
  }
  return randomChoice(targets.map(p => p.number));
}

// ── 獵人開槍 ────────────────────────────────────────────

export async function aiHunterShoot(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;

  const ctx = buildContext(bot, game);
  const history = (game.discussionHistory || [])
    .map(h => `${h.name}：${h.content}`).join('\n') || '無';

  const systemPrompt = `你是狼人殺的獵人，你剛死亡，可以開槍帶走一名玩家。
根據整場遊戲的討論和死亡資訊，判斷誰最可能是狼人。
只輸出一個數字（玩家編號），不加任何說明。`;

  const userPrompt = `存活玩家：${targets.map(p => `${p.number}號${p.displayName}`).join('、')}
已死亡：${ctx.deadPlayers}
討論記錄摘要：\n${history}
選擇開槍目標的編號：`;

  const text = await callGroq(systemPrompt, userPrompt, 5);
  if (text) {
    const num = parseInt(text.trim());
    if (targets.map(p => p.number).includes(num)) return num;
  }
  return randomChoice(targets.map(p => p.number));
}
