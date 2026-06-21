// AIPlayer.js
import OpenAI from 'openai';
import { ROLES, TEAM } from './constants.js';

let openaiClient = null;

function getClient() {
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 只回傳數字的決策
async function askAI(prompt, options) {
  const client = getClient();
  if (!client) return randomChoice(options);
  try {
    const res = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      max_tokens: 10,
      temperature: 0.8,
      messages: [
        { role: 'system', content: '你是狼人殺AI玩家。只回覆一個數字（玩家編號），不加任何說明。' },
        { role: 'user', content: prompt },
      ],
    });
    const num = parseInt(res.choices[0]?.message?.content?.trim());
    return options.includes(num) ? num : randomChoice(options);
  } catch (e) {
    console.warn('[AI] 決策失敗，改用隨機:', e.message);
    return randomChoice(options);
  }
}

// 白天發言：分析局勢，生成一段自然的發言
export async function aiDaySpeak(bot, game, discussionHistory) {
  const client = getClient();

  const aliveList = game.alivePlayers.map(p => `${p.number}.${p.displayName}${p.isBot ? '(AI)' : ''}`).join(', ');
  const isWolf = bot.role === ROLES.WEREWOLF;
  const wolfAllies = isWolf
    ? game.aliveWolves.filter(p => p.id !== bot.id).map(p => p.displayName).join(', ') || '無'
    : null;

  // 建立討論歷史摘要
  const historyText = discussionHistory.length > 0
    ? discussionHistory.map(h => `${h.name}：${h.content}`).join('\n')
    : '（還沒有人發言）';

  const systemPrompt = isWolf
    ? `你是狼人殺遊戲中的玩家，你的名字是「${bot.displayName}」，你的身份是【狼人】。
你的狼人同伴是：${wolfAllies}（不論他們是真人還是AI都是你的隊友）。
你的目標是迷惑好人，讓好人互相懷疑，絕對不能讓你的狼人同伴被放逐。
策略：可以假裝懷疑好人陣營的人，引導票數指向好人，保護所有狼人夥伴。
注意：不能說你是狼人，不能暴露同伴，說話要像普通好人一樣自然。
回覆50字以內的繁體中文發言。`
    : `你是狼人殺遊戲中的玩家，你的名字是「${bot.displayName}」，你的身份是【${bot.role === ROLES.SEER ? '預言家' : bot.role === ROLES.WITCH ? '女巫' : bot.role === ROLES.HUNTER ? '獵人' : '平民'}】。
你是好人陣營，目標是找出並放逐狼人。
${bot.role === ROLES.SEER ? '你有查驗能力，可以根據查驗結果引導討論，但要注意保護自己不被狼人識破。' : ''}
根據其他人的發言邏輯分析誰最可疑，不論對方是真人還是AI都要一視同仁地判斷。
說話要自然，不要說你是AI。
回覆50字以內的繁體中文發言。`;

  const userPrompt = `現在是白天討論階段，第${game.day}天。
存活玩家：${aliveList}
目前討論記錄：
${historyText}

輪到你「${bot.displayName}」發言了，請根據以上討論做出回應：`;

  if (!client) {
    // 沒有 API 時的備用發言
    const fallbacks = isWolf
      ? [`我覺得${randomChoice(game.alivePlayers.filter(p => p.id !== bot.id && p.team !== TEAM.WEREWOLF))?.displayName || '某人'}很可疑。`, '大家冷靜分析一下。', '我沒有什麼特別的線索。']
      : ['我覺得要仔細看大家的反應。', '有人行為很奇怪。', '我支持大家一起分析。'];
    return randomChoice(fallbacks);
  }

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      max_tokens: 80,
      temperature: 0.9,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    return res.choices[0]?.message?.content?.trim() || '我還在思考...';
  } catch (e) {
    console.warn('[AI] 發言失敗:', e.message);
    return '我還在思考...';
  }
}

export async function aiWolfChooseTarget(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && p.team !== TEAM.WEREWOLF);
  if (!targets.length) return null;
  const nums = targets.map(p => p.number);
  return askAI(
    `你是狼人。存活好人：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。優先殺神職。選一個編號：`,
    nums
  );
}

export async function aiSeerChooseTarget(bot, game, checked) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && !checked.has(p.id));
  if (!targets.length) return null;
  const nums = targets.map(p => p.number);
  const memo = [...checked.entries()].map(([id, t]) => {
    const p = game.getPlayer(id);
    return p ? `${p.displayName}=${t === TEAM.WEREWOLF ? '狼' : '好'}` : '';
  }).filter(Boolean).join(', ');
  return askAI(
    `你是預言家。已查：${memo || '無'}。未查：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。選一個編號：`,
    nums
  );
}

export async function aiWitchDecideSave(bot, victim) {
  return Math.random() < 0.7;
}

export async function aiWitchDecidePoison(bot, game) {
  if (Math.random() > 0.4) return null;
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && p.team !== TEAM.WEREWOLF);
  if (!targets.length) return null;
  return randomChoice(targets.map(p => p.number));
}

export async function aiVote(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;
  const nums = targets.map(p => p.number);

  if (bot.role === ROLES.WEREWOLF) {
    // 狼人：只保護同為狼人陣營的玩家（不論真人或AI），投票給好人
    const goodTargets = targets.filter(p => p.team !== TEAM.WEREWOLF);
    if (goodTargets.length) {
      return askAI(
        `你是狼人。存活玩家：${targets.map(p => `${p.number}.${p.displayName}(${p.team === TEAM.WEREWOLF ? '你的同伴' : '好人'})`).join(', ')}。投票給好人陣營的人，不能投自己的狼人同伴，選一個編號：`,
        goodTargets.map(p => p.number)
      );
    }
    return randomChoice(nums);
  }

  // 好人：一視同仁分析，不論對方是真人或AI
  return askAI(
    `你是好人。存活玩家：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。根據發言分析誰最可疑是狼人，選一個編號：`,
    nums
  );
}

export async function aiHunterShoot(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;
  const nums = targets.map(p => p.number);
  return askAI(
    `你是獵人，你死了可以帶走一人。存活：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。選最可疑的狼人，選一個編號：`,
    nums
  );
}
