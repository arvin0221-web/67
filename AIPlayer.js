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
  console.log('[AI] callGroq called, client:', client ? 'OK' : 'NULL', '| KEY:', process.env.GROQ_API_KEY ? 'SET' : 'NOT SET');
  if (!client) return null;
  try {
    const res = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
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

// 從回應中取出 <speech> 標籤內容
function extractSpeech(text) {
  if (!text) return null;
  const match = text.match(/<speech>([\s\S]*?)<\/speech>/i);
  return match ? match[1].trim() : null;
}

// ── 白天發言（雙層思維）──────────────────────────────────

export async function aiDaySpeak(bot, game, discussionHistory) {
  const ctx = buildContext(bot, game);
  const history = discussionHistory.length > 0
    ? discussionHistory.map((h, i) => `[${i + 1}] ${h.name}：${h.content}`).join('\n')
    : '（本輪尚無發言）';

  const systemPrompt = ctx.isWolf
    ? `你是一個狼人殺遊戲的AI玩家，你的真實身份是【狼人】。
你的目標是保護狼人同伴、消滅好人陣營。
你必須偽裝成好人，絕對不能暴露自己或同伴是狼人。

狼人可用的策略：
- 「穿衣服」：裝作普通平民，低調不出風頭
- 「悍跳預言家」：主動宣稱自己是預言家，給狼人同伴發金水、給好人發查殺
- 「倒鉤」：附和好人的分析，但把矛頭引向其他好人
- 「帶節奏」：引導全場懷疑某個威脅最大的好人

請先用 <thinking> 標籤私下思考策略，再用 <speech> 標籤輸出公開發言。
<thinking> 內容不會被其他玩家看到，可以暴露真實想法。
<speech> 內容會被所有人看到，必須完全像好人。
發言限50字，使用繁體中文，像真人玩家，可用狼人殺術語（金水、銀水、查殺、對跳、悍跳）。`
    : ctx.myRole === '預言家'
    ? `你是一個狼人殺遊戲的AI玩家，你的身份是【預言家】。
你每晚可以查驗一名玩家的陣營。
策略：
- 選擇適當時機報出查驗結果
- 若有狼人跳預言家，你要強勢「對跳」並提供更可信的查驗鏈
- 給查驗過的好人「金水」，標記查殺的狼人
請先 <thinking> 分析，再 <speech> 發言。50字內，繁體中文。`
    : ctx.myRole === '女巫'
    ? `你是一個狼人殺遊戲的AI玩家，你的身份是【女巫】。
你有一瓶解藥（銀水）和一瓶毒藥，各只能用一次。
策略：
- 若你昨晚使用了解藥救了某人，可以在今天宣布「銀水」保護那個人（讓大家知道那人是好人）
- 謹慎決定要不要公開自己是女巫（公開有風險但能保護銀水目標）
- 若你已知道某人是狼人，可暗示或直接說出
- 分析誰是狼人，在投票時引導方向
請先 <thinking> 分析，再 <speech> 發言。50字內，繁體中文。`
    : ctx.myRole === '獵人'
    ? `你是一個狼人殺遊戲的AI玩家，你的身份是【獵人】。
你死亡時可以帶走一名玩家。
策略：
- 觀察並記住最可疑的狼人，死後帶走
- 可以威脅：「如果我死，我會帶走我認為的狼人」
請先 <thinking> 分析，再 <speech> 發言。50字內，繁體中文。`
    : `你是一個狼人殺遊戲的AI玩家，你的身份是【平民】。
你沒有特殊技能，只能靠觀察和分析找出狼人。
策略：
- 仔細分析每個人的發言邏輯和矛盾點
- 不要盲目跟風，用理性判斷
- 注意誰在帶節奏、誰的發言前後矛盾
請先 <thinking> 分析，再 <speech> 發言。50字內，繁體中文。`;

  // 女巫額外資訊：藥品狀態和銀水目標
  let witchExtra = '';
  if (bot.role === ROLES.WITCH) {
    const saveStatus = game.witchSaveUsed ? '已使用' : '未使用';
    const poisonStatus = game.witchPoisonUsed ? '已使用' : '未使用';
    const savedTarget = game.witchSavedTarget
      ? `昨晚我用解藥救了 ${game.getPlayer(game.witchSavedTarget)?.displayName || '某人'}（可以考慮今天報銀水保護他）`
      : '';
    witchExtra = `\n【女巫藥品狀態】解藥：${saveStatus}｜毒藥：${poisonStatus}${savedTarget ? '\n' + savedTarget : ''}`;
  }

  const userPrompt = `【遊戲情境】
第${ctx.day}天白天 | 我是 ${ctx.myNumber}號${ctx.myName}（身份：${ctx.myRole}）
${ctx.isWolf ? `我的狼人同伴：${ctx.wolfAllies}` : ''}
存活玩家：${ctx.alivePlayers}
已死亡：${ctx.deadPlayers}${witchExtra}

【本輪討論記錄】
${history}

現在輪到我「${ctx.myName}」發言，請先 <thinking> 分析局勢和策略，再 <speech> 輸出公開發言：`;

  const text = await callGroq(systemPrompt, userPrompt, 400);
  const speech = extractSpeech(text);
  if (speech) return speech.slice(0, 150);

  // Fallback
  const fallbacks = ctx.isWolf
    ? ['我覺得需要仔細觀察大家的發言。', '目前沒有太明顯的線索，先聽聽大家說。', '我認同剛才的分析，我們要冷靜。']
    : ['我覺得要注意發言前後矛盾的人。', '大家有沒有注意到某些人說話很奇怪？', '我先聽聽大家的分析再表態。'];
  return randomChoice(fallbacks);
}

// ── 狼人選擇擊殺目標 ──────────────────────────────────

export async function aiWolfChooseTarget(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;

  const ctx = buildContext(bot, game);
  const targetList = targets.map(p =>
    `${p.number}號${p.displayName}（${p.team === TEAM.WEREWOLF ? '狼人同伴' : '好人'}）`
  ).join('、');

  const systemPrompt = `你是狼人殺的狼人，現在要選擇今晚的擊殺目標。
優先順序：預言家 > 女巫 > 獵人 > 平民。
你也可以殺狼人同伴作為掩護，但通常不建議。
只輸出一個數字（玩家編號），不加任何說明。`;

  const userPrompt = `我的狼人同伴：${ctx.wolfAllies}
存活玩家：${targetList}
已死亡：${ctx.deadPlayers}
選擇今晚擊殺目標的編號：`;

  const text = await callGroq(systemPrompt, userPrompt, 5);
  if (text) {
    const num = parseInt(text.trim());
    if (targets.map(p => p.number).includes(num)) return num;
  }
  // 優先殺神職
  const specials = targets.filter(p => p.team !== TEAM.WEREWOLF &&
    [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER].includes(p.role));
  if (specials.length) return randomChoice(specials.map(p => p.number));
  return randomChoice(targets.filter(p => p.team !== TEAM.WEREWOLF).map(p => p.number) || targets.map(p => p.number));
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
