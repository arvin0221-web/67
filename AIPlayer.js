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
        model: 'gemini-1.5-flash',
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
  const targets = game.alivePlayers.filter(p => p.id !== bot.id && p.team !== TEAM.WEREWOLF);
  if (!targets.length) return null;
  return askAI(
    `你是狼人殺的狼人。存活好人：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。優先殺神職（預言家、女巫、獵人），選一個編號：`,
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

  if (bot.role === ROLES.WEREWOLF) {
    // 保護所有狼人陣營（不分真人或AI），只投好人
    const goodTargets = targets.filter(p => p.team !== TEAM.WEREWOLF);
    if (goodTargets.length) {
      return askAI(
        `你是狼人。存活玩家：${targets.map(p => `${p.number}.${p.displayName}(${p.team === TEAM.WEREWOLF ? '你的同伴' : '好人'})`).join(', ')}。投票給好人陣營，不能投狼人同伴，選一個編號：`,
        goodTargets.map(p => p.number)
      );
    }
    return randomChoice(targets.map(p => p.number));
  }

  return askAI(
    `你是狼人殺好人陣營。存活玩家：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。根據邏輯判斷誰最可能是狼人，選一個編號：`,
    targets.map(p => p.number)
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
