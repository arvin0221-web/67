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

// 基本 Groq 呼叫
async function callGroq(messages, maxTokens = 200) {
  const client = getClient();
  if (!client) return null;
  try {
    const res = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature: 0.85,
      messages,
    });
    const text = res.choices[0]?.message?.content?.trim() ?? null;
    console.log('[AI] 回應:', text?.slice(0, 100) ?? 'NULL');
    return text;
  } catch (e) {
    console.warn('[AI] Groq 失敗:', e.message?.slice(0, 100));
    return null;
  }
}

// 只回傳數字的決策
async function askNumber(systemPrompt, userPrompt, options) {
  const text = await callGroq([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt + '\n\n只回覆一個數字（玩家編號），不加任何說明。' },
  ], 5);
  if (text) {
    const num = parseInt(text.trim());
    if (options.includes(num)) return num;
  }
  return randomChoice(options);
}

// 建立基本情境
function buildCtx(bot, game) {
  const roleLabel = {
    [ROLES.WEREWOLF]: '狼人', [ROLES.SEER]: '預言家',
    [ROLES.WITCH]: '女巫', [ROLES.HUNTER]: '獵人', [ROLES.VILLAGER]: '平民',
  }[bot.role] || '平民';

  const alive = game.alivePlayers.map(p => `${p.number}號${p.displayName}`).join('、');
  const dead = [...game.players.values()].filter(p => !p.alive)
    .map(p => `${p.number}號${p.displayName}(${ROLE_NAMES[p.role]})`).join('、') || '無';
  const isWolf = bot.role === ROLES.WEREWOLF;
  const wolfAllies = isWolf
    ? game.aliveWolves.filter(p => p.id !== bot.id).map(p => `${p.number}號${p.displayName}`).join('、') || '無'
    : null;

  return { roleLabel, alive, dead, isWolf, wolfAllies, day: game.day, num: bot.number, name: bot.displayName };
}

// ── 白天發言 ────────────────────────────────────────────

export async function aiDaySpeak(bot, game, discussionHistory) {
  const ctx = buildCtx(bot, game);

  // 本輪討論
  const todayHistory = discussionHistory.length > 0
    ? discussionHistory.map(h => `${h.name}：${h.content}`).join('\n')
    : '（尚無人發言）';

  // 跨天歷史
  const pastHistory = (game.allDiscussionHistory || [])
    .map(d => `第${d.day}天：\n${d.speeches.map(h => `  ${h.name}：${h.content}`).join('\n')}`)
    .join('\n\n') || '無';

  // 女巫資訊
  let witchInfo = '';
  if (bot.role === ROLES.WITCH) {
    const saved = game.witchSavedTarget ? game.getPlayer(game.witchSavedTarget)?.displayName : null;
    witchInfo = `\n我的藥品：解藥${game.witchSaveUsed ? '已用' : '未用'}、毒藥${game.witchPoisonUsed ? '已用' : '未用'}`;
    if (saved) witchInfo += `\n我曾救了【${saved}】，他是我的銀水，我可以今天公開保護他`;
  }

  // 預言家資訊
  let seerInfo = '';
  if (bot.role === ROLES.SEER) {
    const mem = game._seerMemoryForBot?.[bot.id];
    if (mem && mem.size > 0) {
      const results = [...mem.entries()].map(([id, team]) => {
        const p = game.getPlayer(id);
        return p ? `${p.displayName}是${team === TEAM.WEREWOLF ? '【狼人】查殺' : '【好人】金水'}` : '';
      }).filter(Boolean).join('、');
      seerInfo = `\n我的查驗結果：${results}，我應該主動報出來讓大家知道`;
    }
  }

  // 平安夜資訊
  const peacefulNote = ctx.isWolf && game.witchSaveUsed
    ? `\n曾有平安夜（女巫解藥已用完），自刀無意義` : '';

  let systemPrompt, userPrompt;

  if (ctx.isWolf) {
    systemPrompt = `你在玩狼人殺，你的真實身份是狼人，但你必須完全偽裝成好人。
絕對禁止：承認自己是狼人、說「我是狼人」、暗示自己身份。
你要做的：說謊、引導懷疑好人、保護你的狼人同伴。
可用策略：穿衣服（低調）、悍跳預言家（主動說自己是預言家並發金水給同伴）、倒鉤（引導懷疑好人）。
第二天起：找出好人發言的邏輯漏洞攻擊他們。
輸出格式：直接輸出你要說的話，不要有任何標籤、括號說明或旁白，純粹就是你對玩家說的話。語氣自然像真人，不要列點，80字以內，繁體中文。`;

    userPrompt = `我是${ctx.num}號${ctx.name}（對外身份保密）
我的狼人同伴：${ctx.wolfAllies}${peacefulNote}
存活：${ctx.alive}
死亡：${ctx.dead}

過去發言記錄：
${pastHistory}

今天發言記錄：
${todayHistory}

現在輪到我發言，我要說什麼？（記住：完全像好人，絕對不能說我是狼人）`;

  } else {
    const hasInfo = (bot.role === ROLES.SEER && seerInfo) ||
                    (bot.role === ROLES.WITCH && witchInfo.includes('銀水'));
    const dayNote = ctx.day === 1
      ? '這是第一天，沒有任何資訊，直接說你先觀察即可。'
      : '第二天起，你可以分析過去發言的邏輯漏洞，指出誰說話前後矛盾或可疑。';

    systemPrompt = `你在玩狼人殺，你的身份是${ctx.roleLabel}，你是好人陣營。
發言原則：
- 有資訊（查驗結果/銀水/毒藥線索）就直接說出來，不要藏
- 沒有資訊就說「我沒有特別資訊，先觀察」，不要硬分析廢話
- 不要分析「他說他是平民，可能是真的也可能假的」這種無用內容
- ${dayNote}
輸出格式：直接輸出你要說的話，不要有任何標籤、括號說明或旁白，純粹就是你對其他玩家說的話。語氣自然像真人，不要列點，80字以內，繁體中文。`;

    userPrompt = `我是${ctx.num}號${ctx.name}（${ctx.roleLabel}）${witchInfo}${seerInfo}
存活：${ctx.alive}
死亡：${ctx.dead}

過去發言記錄：
${pastHistory}

今天發言記錄：
${todayHistory}

現在輪到我發言，我要說什麼？${hasInfo ? '（記得把我的資訊說出來！）' : '（如果沒有特別資訊，就直接說沒有）'}`;
  }

  const text = await callGroq([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], 200);

  if (text) {
    // 清理任何殘留標籤
    const cleaned = text
      .replace(/<\/?(?:thinking|speech|answer)>/gi, '')
      .replace(/^(?:我說：|發言：|speech:|answer:)\s*/i, '')
      .trim();
    if (cleaned.length > 3) return cleaned;
  }

  // Fallback
  if (ctx.isWolf) return '我先觀察一下，沒有特別的看法。';
  return ctx.day === 1 ? '我是新人，先聽大家說吧。' : '我目前沒有特別的線索。';
}

// ── 狼人選擇擊殺目標 ──────────────────────────────────

export async function aiWolfChooseTarget(bot, game) {
  const witchSaveUsed = game.witchSaveUsed;
  const allTargets = game.alivePlayers.filter(p => p.id !== bot.id);
  const goodTargets = allTargets.filter(p => p.team !== TEAM.WEREWOLF);
  const targets = witchSaveUsed ? goodTargets : allTargets;
  if (!targets.length) return null;

  const wolfAllies = game.aliveWolves.filter(p => p.id !== bot.id).map(p => `${p.number}號${p.displayName}`).join('、') || '無';
  const witchNote = witchSaveUsed ? '女巫解藥已用完，只選好人目標。' : '女巫解藥未使用，可以選狼人同伴製造自刀局（但通常不建議）。';
  const dead = [...game.players.values()].filter(p => !p.alive).map(p => `${p.number}號${p.displayName}(${ROLE_NAMES[p.role]})`).join('、') || '無';

  return askNumber(
    `你是狼人殺的狼人，要選今晚的擊殺目標。優先殺：預言家>女巫>獵人>平民。${witchNote}`,
    `我的同伴：${wolfAllies}\n可選目標：${targets.map(p => `${p.number}號${p.displayName}（${p.team === TEAM.WEREWOLF ? '狼人同伴' : '好人'}）`).join('、')}\n死亡：${dead}`,
    targets.map(p => p.number)
  );
}

// ── 預言家選擇查驗目標 ────────────────────────────────

export async function aiSeerChooseTarget(bot, game, checked) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && !checked.has(p.id));
  if (!targets.length) return null;

  // 存查驗記憶讓白天發言能用
  if (!game._seerMemoryForBot) game._seerMemoryForBot = {};
  game._seerMemoryForBot[bot.id] = checked;

  const memo = [...checked.entries()].map(([id, t]) => {
    const p = game.getPlayer(id);
    return p ? `${p.displayName}=${t === TEAM.WEREWOLF ? '狼人' : '好人'}` : '';
  }).filter(Boolean).join('、') || '尚未查驗';

  return askNumber(
    `你是狼人殺的預言家，選今晚查驗目標。優先查驗最可疑的人或尚未有資訊的人。`,
    `已查驗：${memo}\n未查驗：${targets.map(p => `${p.number}號${p.displayName}`).join('、')}`,
    targets.map(p => p.number)
  );
}

// ── 女巫 ──────────────────────────────────────────────

export async function aiWitchDecideSave(bot, victim) {
  return game?.day === 1 ? true : Math.random() < 0.7;
}

export async function aiWitchDecidePoison(bot, game) {
  if (Math.random() > 0.35) return null;
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && p.team !== TEAM.WEREWOLF);
  if (!targets.length) return null;
  return randomChoice(targets.map(p => p.number));
}

// ── 投票 ──────────────────────────────────────────────

export async function aiVote(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;

  const ctx = buildCtx(bot, game);
  const todayHistory = (game.discussionHistory || []).map(h => `${h.name}：${h.content}`).join('\n') || '無';
  const pastHistory = (game.allDiscussionHistory || [])
    .map(d => `第${d.day}天：\n${d.speeches.map(h => `  ${h.name}：${h.content}`).join('\n')}`).join('\n\n') || '無';
  const dead = [...game.players.values()].filter(p => !p.alive)
    .map(p => `${p.number}號${p.displayName}(${ROLE_NAMES[p.role]})`).join('、') || '無';

  if (ctx.isWolf) {
    const goodTargets = targets.filter(p => p.team !== TEAM.WEREWOLF);
    if (!goodTargets.length) return randomChoice(targets.map(p => p.number));

    return askNumber(
      `你是狼人殺的狼人，要投票放逐一名好人。絕對不能投自己的狼人同伴。
根據討論記錄，選一個投票最自然、最不會讓自己被懷疑的好人目標。`,
      `我的同伴：${ctx.wolfAllies}
存活：${targets.map(p => `${p.number}號${p.displayName}(${p.team === TEAM.WEREWOLF ? '我的同伴' : '好人'})`).join('、')}
今天討論：\n${todayHistory}\n過去記錄：\n${pastHistory}\n死亡：${dead}`,
      goodTargets.map(p => p.number)
    );
  }

  // 好人投票：根據討論邏輯判斷
  return askNumber(
    `你是狼人殺的${ctx.roleLabel}，要投票放逐最可能是狼人的玩家。
分析方法：
1. 誰的發言前後矛盾？
2. 誰在帶節奏、轉移矛頭？
3. 誰為了保護某個特定玩家不讓他被投？
4. 誰說話模糊、沒有實質內容、一直說「先觀察」但從不給資訊？
5. 有沒有人自爆身份或承認是狼人？那就直接投他！
根據以上邏輯選出最可疑的人。`,
    `我是${ctx.num}號${ctx.name}（${ctx.roleLabel}）
存活：${targets.map(p => `${p.number}號${p.displayName}`).join('、')}
今天討論：\n${todayHistory}\n過去記錄：\n${pastHistory}\n死亡：${dead}`,
    targets.map(p => p.number)
  );
}

// ── 獵人開槍 ──────────────────────────────────────────

export async function aiHunterShoot(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;

  const ctx = buildCtx(bot, game);
  const pastHistory = (game.allDiscussionHistory || [])
    .map(d => `第${d.day}天：\n${d.speeches.map(h => `  ${h.name}：${h.content}`).join('\n')}`).join('\n\n') || '無';

  return askNumber(
    `你是狼人殺的獵人，你死了可以帶走一名玩家。根據所有討論記錄，選最可能是狼人的人。`,
    `存活：${targets.map(p => `${p.number}號${p.displayName}`).join('、')}\n死亡：${ctx.dead}\n過去記錄：\n${pastHistory}`,
    targets.map(p => p.number)
  );
}
