// AIPlayer.js
import { GoogleGenAI } from '@google/genai';
import { ROLES, TEAM } from './constants.js';

let ai = null;

function getAI() {
  if (!ai && process.env.GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return ai;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function askGemini(prompt, retries = 2) {
  const client = getAI();
  if (!client) return null;
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      return response.text?.trim() ?? null;
    } catch (e) {
      if (e.message?.includes('429') && i < retries) {
        console.warn(`[AI] 限流，等待 ${(i + 1) * 5} 秒後重試...`);
        await sleep((i + 1) * 5000);
      } else {
        console.warn('[AI] Gemini 呼叫失敗:', e.message?.slice(0, 100));
        return null;
      }
    }
  }
  return null;
}

async function askAI(prompt, options) {
  const text = await askGemini(`${prompt}\n只回覆一個數字（玩家編號），不加任何說明或標點符號。`);
  if (text) {
    const num = parseInt(text);
    if (options.includes(num)) return num;
  }
  return randomChoice(options);
}

// 白天發言
export async function aiDaySpeak(bot, game, discussionHistory) {
  const aliveList = game.alivePlayers.map(p => `${p.number}.${p.displayName}`).join(', ');
  const isWolf = bot.role === ROLES.WEREWOLF;
  const wolfAllies = isWolf
    ? game.aliveWolves.filter(p => p.id !== bot.id).map(p => p.displayName).join(', ') || '無'
    : null;
  const historyText = discussionHistory.length > 0
    ? discussionHistory.map(h => `${h.name}：${h.content}`).join('\n')
    : '（還沒有人發言）';
  const roleLabel = { [ROLES.SEER]: '預言家', [ROLES.WITCH]: '女巫', [ROLES.HUNTER]: '獵人', [ROLES.VILLAGER]: '平民' }[bot.role] || '平民';

  const prompt = isWolf
    ? `你正在玩狼人殺，你是「${bot.displayName}」，身份是狼人。
狼人同伴：${wolfAllies}（不論真人或AI都是你的隊友，要保護他們）。
第${game.day}天白天。存活玩家：${aliveList}
討論記錄：\n${historyText}
目標：迷惑好人，引導票數投向好人，保護狼人同伴。不能承認自己是狼人。
用繁體中文發言，50字以內，不要說你是AI。`
    : `你正在玩狼人殺，你是「${bot.displayName}」，身份是${roleLabel}。
你是好人陣營，目標是找出並放逐狼人。
第${game.day}天白天。存活玩家：${aliveList}
討論記錄：\n${historyText}
根據發言邏輯分析誰最可疑，不論對方是真人或AI都要一視同仁。
用繁體中文發言，50字以內，不要說你是AI。`;

  const text = await askGemini(prompt);
  if (text) return text.slice(0, 100);

  // Fallback
  const fallbacks = isWolf
    ? ['我覺得要冷靜分析。', '有些人的發言很奇怪。', '我沒有特別的線索。']
    : ['我覺得要仔細看大家反應。', '有人說話很可疑。', '大家一起分析吧。'];
  return randomChoice(fallbacks);
}

export async function aiWolfChooseTarget(bot, game) {
  // 可以殺任何人（包含狼人同伴），排除自己
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;
  const goodTargets = targets.filter(p => p.team !== TEAM.WEREWOLF);
  const preferredNums = goodTargets.length ? goodTargets.map(p => p.number) : targets.map(p => p.number);
  return askAI(
    `你是狼人殺的狼人。存活玩家：${targets.map(p => `${p.number}.${p.displayName}(${p.team === TEAM.WEREWOLF ? '狼人同伴' : '好人'})`).join(', ')}。優先殺神職（預言家、女巫、獵人），也可以殺狼人同伴作為掩護，選一個編號：`,
    targets.map(p => p.number)
  );
}

export async function aiSeerChooseTarget(bot, game, checked) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && !checked.has(p.id));
  if (!targets.length) return null;
  const memo = [...checked.entries()].map(([id, t]) => {
    const p = game.getPlayer(id);
    return p ? `${p.displayName}=${t === TEAM.WEREWOLF ? '狼' : '好'}` : '';
  }).filter(Boolean).join(', ');
  return askAI(
    `你是狼人殺的預言家。已查：${memo || '無'}。未查：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。選最可疑的查驗，選一個編號：`,
    targets.map(p => p.number)
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

  const history = (game.discussionHistory || [])
    .map(h => `${h.name}：${h.content}`).join('\n') || '（無討論記錄）';

  if (bot.role === ROLES.WEREWOLF) {
    const goodTargets = targets.filter(p => p.team !== TEAM.WEREWOLF);
    if (!goodTargets.length) return randomChoice(nums);
    return askAI(
      `你是狼人殺的狼人，你的名字是「${bot.displayName}」。\n存活玩家：${targets.map(p => `${p.number}.${p.displayName}(${p.team === TEAM.WEREWOLF ? '你的狼人同伴' : '好人'})`).join(', ')}。\n白天討論記錄：\n${history}\n根據討論記錄，選一個好人陣營的玩家投票放逐，不能投狼人同伴，讓選擇看起來合理，選一個編號：`,
      goodTargets.map(p => p.number)
    );
  }

  const roleLabel = bot.role === ROLES.SEER ? '預言家' : bot.role === ROLES.WITCH ? '女巫' : bot.role === ROLES.HUNTER ? '獵人' : '平民';
  return askAI(
    `你是狼人殺的${roleLabel}，你的名字是「${bot.displayName}」。\n存活玩家：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。\n白天討論記錄：\n${history}\n根據討論記錄分析每個人的行為邏輯，判斷誰最可能是狼人，投票放逐他，選一個編號：`,
    nums
  );
}

export async function aiHunterShoot(bot, game) {
  const targets = game.alivePlayers.filter(p => p.id !== bot.id);
  if (!targets.length) return null;
  return askAI(
    `你是狼人殺的獵人，你死了可以帶走一人。存活：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。選最可疑的狼人，選一個編號：`,
    targets.map(p => p.number)
  );
}
