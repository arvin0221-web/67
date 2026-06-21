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
    console.warn('[AI] API失敗，改用隨機:', e.message);
    return randomChoice(options);
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
  // 70% 機率救人
  return Math.random() < 0.7;
}

export async function aiWitchDecidePoison(bot, game) {
  // 40% 機率使用毒藥
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
    // 狼人：避免投自己的同伴
    const safeTargets = targets.filter(p => p.team !== TEAM.WEREWOLF);
    if (safeTargets.length) return randomChoice(safeTargets.map(p => p.number));
    return randomChoice(nums);
  }

  return askAI(
    `你是好人。存活玩家：${targets.map(p => `${p.number}.${p.displayName}`).join(', ')}。投票放逐最可疑的狼人，選一個編號：`,
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
