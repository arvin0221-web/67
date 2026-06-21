// GameEngine.js
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { ROLES, ROLE_NAMES, TEAM, GAME_PHASE, EMOJIS } from './constants.js';
import { GameState } from './GameState.js';
import * as AI from './AIPlayer.js';

const games = new Map();
const seerMemory = new Map(); // channelId -> Map(playerId -> team)

export function getGame(channelId) { return games.get(channelId); }
export function hasGame(channelId) { return games.has(channelId); }

export function createGame(channelId, mode) {
  const game = new GameState(channelId, mode);
  games.set(channelId, game);
  seerMemory.set(channelId, new Map());
  return game;
}

export function destroyGame(channelId) {
  games.delete(channelId);
  seerMemory.delete(channelId);
}

// ── Embeds ──────────────────────────────────────────────

export function buildLobbyEmbed(game) {
  const playerList = game.players.size > 0
    ? [...game.players.values()].map(p => `${p.number}. ${p.displayName}`).join('\n')
    : '（尚無玩家）';
  const roleList = [...new Set(game.mode.roles)].map(r => ROLE_NAMES[r]).join(' | ');
  return new EmbedBuilder()
    .setColor(0x2B2D31)
    .setTitle(`${EMOJIS.VILLAGE} 狼人殺 — ${game.mode.name}`)
    .setDescription(`**勝利條件**：${game.mode.winCondition === 'kill_all_specials'
      ? '屠城局（狼人殺光所有神職=勝）' : '屠邊局（狼人殺光平民或神職=勝）'}`)
    .addFields(
      { name: '角色配置', value: roleList },
      { name: `玩家列表 (${game.players.size}/${game.mode.total})`, value: playerList },
    )
    .setFooter({ text: '點擊按鈕加入 | 人不夠可加AI玩家' });
}

export function buildJoinButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join_game').setLabel('加入遊戲').setStyle(ButtonStyle.Primary).setEmoji('✋'),
    new ButtonBuilder().setCustomId('add_bot').setLabel('加入AI玩家').setStyle(ButtonStyle.Secondary).setEmoji('🤖'),
    new ButtonBuilder().setCustomId('start_game').setLabel('開始遊戲').setStyle(ButtonStyle.Success).setEmoji('▶️'),
    new ButtonBuilder().setCustomId('cancel_game').setLabel('取消').setStyle(ButtonStyle.Danger).setEmoji('✖️'),
  );
}

function buildVoteComponents(game) {
  const alive = game.alivePlayers;
  if (alive.length <= 5) {
    const rows = [];
    const btns = alive.map(p =>
      new ButtonBuilder().setCustomId(`vote_${p.id}`).setLabel(`${p.number}. ${p.username.substring(0, 12)}`).setStyle(ButtonStyle.Secondary)
    );
    for (let i = 0; i < btns.length; i += 5)
      rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i + 5)));
    return rows;
  }
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('vote_select').setPlaceholder('選擇要放逐的玩家')
      .addOptions(alive.map(p => ({ label: `${p.number}. ${p.username}`, value: p.id })))
  )];
}

// ── 夜晚主流程 ──────────────────────────────────────────

export async function startNight(game, channel, client) {
  game.phase = GAME_PHASE.NIGHT;
  game.day += 1;
  game.wolfTarget = null;
  game.witchPoisonTarget = null;

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x1a1a2e)
      .setTitle(`${EMOJIS.MOON} 第 ${game.day} 夜`)
      .setDescription('天黑請閉眼...\n請等待私訊行動指示。')
      .addFields({ name: '存活玩家', value: game.formatPlayerList() })]
  });
  await delay(1500);
  await phaseWerewolf(game, channel, client);
}

// ── 狼人 ────────────────────────────────────────────────

async function phaseWerewolf(game, channel, client) {
  const wolves = game.aliveWolves;
  const realWolves = wolves.filter(p => !p.isBot);
  const botWolves  = wolves.filter(p => p.isBot);

  // AI 狼人預先決定
  let botChoice = null;
  for (const bw of botWolves) {
    const num = await AI.aiWolfChooseTarget(bw, game);
    if (num != null) { botChoice = game.getPlayerByNumber(num)?.id ?? null; break; }
  }

  if (realWolves.length === 0) {
    game.wolfTarget = botChoice;
    return phaseSeer(game, channel, client);
  }

  const wolfNames = wolves.map(p => `${p.displayName}(${p.number})`).join(', ');
  for (const wolf of realWolves) {
    try {
      const u = await client.users.fetch(wolf.id);
      const targets = game.alivePlayers.filter(p => p.team !== TEAM.WEREWOLF);
      await u.send({
        embeds: [new EmbedBuilder().setColor(0x8B0000)
          .setTitle(`${EMOJIS.MOON} 狼人行動 — 第${game.day}夜`)
          .setDescription(`你的狼人同伴：**${wolfNames}**\n\n請在 60 秒內選擇今晚的擊殺目標：`)],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`wolf_kill_${game.channelId}`).setPlaceholder('選擇擊殺目標')
            .addOptions(targets.map(p => ({ label: `${p.number}. ${p.username}`, value: p.id })))
        )],
      });
    } catch (e) { console.error(`私訊狼人失敗:`, e.message); }
  }

  game._wolfBotChoice = botChoice;
  game._wolfTimer = setTimeout(async () => {
    if (!game.wolfTarget) game.wolfTarget = game._wolfBotChoice ?? null;
    delete game._wolfTimer; delete game._wolfBotChoice;
    await phaseSeer(game, channel, client);
  }, 60_000);
}

export async function completeWolfKill(game, targetId, channel, client) {
  if (game._wolfTimer) { clearTimeout(game._wolfTimer); delete game._wolfTimer; }
  delete game._wolfBotChoice;
  game.wolfTarget = targetId;
  await phaseSeer(game, channel, client);
}

// ── 預言家 ──────────────────────────────────────────────

async function phaseSeer(game, channel, client) {
  const seer = game.alivePlayers.find(p => p.role === ROLES.SEER);
  if (!seer) return phaseWitch(game, channel, client);

  const memory = seerMemory.get(game.channelId) || new Map();

  if (seer.isBot) {
    const num = await AI.aiSeerChooseTarget(seer, game, memory);
    if (num != null) {
      const t = game.getPlayerByNumber(num);
      if (t) memory.set(t.id, t.team);
      seerMemory.set(game.channelId, memory);
    }
    return phaseWitch(game, channel, client);
  }

  const checkedInfo = [...memory.entries()]
    .map(([id, team]) => { const p = game.getPlayer(id); return p ? `${p.displayName}：${team === TEAM.WEREWOLF ? '🔴狼人' : '🟢好人'}` : ''; })
    .filter(Boolean).join('\n') || '（尚未查驗）';
  const targets = game.alivePlayers.filter(p => p.id !== seer.id);

  try {
    const u = await client.users.fetch(seer.id);
    await u.send({
      embeds: [new EmbedBuilder().setColor(0x9B59B6)
        .setTitle(`${EMOJIS.MOON} 預言家行動 — 第${game.day}夜`)
        .setDescription(`**已查驗：**\n${checkedInfo}\n\n請在 60 秒內選擇今晚要查驗的玩家：`)],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`seer_check_${game.channelId}`).setPlaceholder('選擇查驗對象')
          .addOptions(targets.map(p => ({ label: `${p.number}. ${p.username}`, value: p.id })))
      )],
    });
  } catch (e) { console.error('私訊預言家失敗:', e.message); }

  game._seerTimer = setTimeout(async () => {
    delete game._seerTimer;
    await phaseWitch(game, channel, client);
  }, 60_000);
}

export async function completeSeerCheck(game, seerId, targetId, client, channel) {
  if (game._seerTimer) { clearTimeout(game._seerTimer); delete game._seerTimer; }
  const target = game.getPlayer(targetId);
  if (target) {
    const memory = seerMemory.get(game.channelId) || new Map();
    memory.set(target.id, target.team);
    seerMemory.set(game.channelId, memory);
    try {
      const u = await client.users.fetch(seerId);
      const isWolf = target.team === TEAM.WEREWOLF;
      await u.send({ embeds: [new EmbedBuilder()
        .setColor(isWolf ? 0x8B0000 : 0x2E8B57)
        .setTitle('🔮 查驗結果')
        .setDescription(`**${target.displayName}** — ${isWolf ? '🔴 是【狼人】！' : '🟢 是【好人】。'}`)] });
    } catch (e) { console.error('回傳查驗結果失敗:', e.message); }
  }
  await phaseWitch(game, channel, client);
}

// ── 女巫 ────────────────────────────────────────────────

async function phaseWitch(game, channel, client) {
  const witch = game.alivePlayers.find(p => p.role === ROLES.WITCH);
  if (!witch) return resolveNight(game, channel, client);

  const victim = game.wolfTarget ? game.getPlayer(game.wolfTarget) : null;
  const canSave   = !!(victim && victim.alive && !game.witchSaveUsed);
  const canPoison = !game.witchPoisonUsed;

  if (witch.isBot) {
    if (canSave && await AI.aiWitchDecideSave(witch, victim)) {
      game.witchSaveUsed = true; victim.protected = true; game.wolfTarget = null;
    }
    if (canPoison) {
      const num = await AI.aiWitchDecidePoison(witch, game);
      if (num != null) {
        const t = game.getPlayerByNumber(num);
        if (t) { game.witchPoisonUsed = true; game.witchPoisonTarget = t.id; }
      }
    }
    return resolveNight(game, channel, client);
  }

  if (!canSave && !canPoison) {
    try {
      const u = await client.users.fetch(witch.id);
      await u.send({ embeds: [new EmbedBuilder().setColor(0x8B008B)
        .setTitle(`${EMOJIS.MOON} 女巫行動 — 第${game.day}夜`).setDescription('你的藥品都已用完，今晚無法行動。')] });
    } catch (_) {}
    return resolveNight(game, channel, client);
  }

  try {
    const u = await client.users.fetch(witch.id);
    const components = [];
    let desc = '';

    if (canSave) {
      desc += `🔪 今晚被狼人殺死的是：**${victim.displayName}**\n你還有解藥，是否救他？\n\n`;
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`witch_save_yes_${game.channelId}`).setLabel('✅ 使用解藥').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`witch_save_no_${game.channelId}`).setLabel('❌ 不救').setStyle(ButtonStyle.Secondary),
      ));
    } else {
      desc += victim ? '（解藥已使用）\n\n' : '今晚沒有人被狼人殺死。\n\n';
    }

    if (canPoison) {
      const targets = game.alivePlayers.filter(p => p.id !== witch.id);
      desc += '你還有毒藥，是否毒殺某人？';
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`witch_poison_${game.channelId}`).setPlaceholder('選擇毒殺目標，或「不使用」')
          .addOptions([
            ...targets.map(p => ({ label: `${p.number}. ${p.username}`, value: p.id })),
            { label: '❌ 不使用毒藥', value: 'skip' },
          ])
      ));
    }

    await u.send({
      embeds: [new EmbedBuilder().setColor(0x8B008B)
        .setTitle(`${EMOJIS.MOON} 女巫行動 — 第${game.day}夜`).setDescription(desc)],
      components,
    });
    game._witchSaveDone   = !canSave;
    game._witchPoisonDone = !canPoison;
  } catch (e) {
    console.error('私訊女巫失敗:', e.message);
    return resolveNight(game, channel, client);
  }

  game._witchTimer = setTimeout(async () => {
    delete game._witchTimer;
    await resolveNight(game, channel, client);
  }, 90_000);
}

export async function completeWitchSave(game, witchId, save, client, channel) {
  const victim = game.wolfTarget ? game.getPlayer(game.wolfTarget) : null;
  game.witchSaveUsed = true;
  if (save && victim) { victim.protected = true; game.wolfTarget = null; }
  game._witchSaveDone = true;
  await checkWitchDone(game, channel, client);
}

export async function completeWitchPoison(game, witchId, targetId, client, channel) {
  game.witchPoisonUsed = true;
  if (targetId && targetId !== 'skip') {
    const t = game.getPlayer(targetId);
    if (t) game.witchPoisonTarget = t.id;
  }
  game._witchPoisonDone = true;
  await checkWitchDone(game, channel, client);
}

async function checkWitchDone(game, channel, client) {
  if (game._witchSaveDone && game._witchPoisonDone) {
    if (game._witchTimer) { clearTimeout(game._witchTimer); delete game._witchTimer; }
    await resolveNight(game, channel, client);
  }
}

// ── 夜晚結算 ────────────────────────────────────────────

async function resolveNight(game, channel, client) {
  const deaths = game.resolveNight();
  if (game.checkWinCondition()) return endGame(game, channel, client);

  game.phase = GAME_PHASE.DAY;
  await delay(1000);

  const deathMsg = deaths.length > 0
    ? deaths.map(p => `💀 **${p.displayName}** (${ROLE_NAMES[p.role]})`).join('\n')
    : '昨晚是平安夜，沒有人死亡。';

  await channel.send({ embeds: [new EmbedBuilder().setColor(0xFFD700)
    .setTitle(`${EMOJIS.SUN} 第 ${game.day} 天 — 天亮了`)
    .setDescription(deathMsg)
    .addFields({ name: '存活玩家', value: game.formatPlayerList() })
    .setFooter({ text: '請討論並等待投票' })] });

  for (const dead of deaths) {
    if (dead.role === ROLES.HUNTER) return triggerHunterShot(game, channel, client, dead);
  }

  await delay(30_000);
  await startVote(game, channel, client);
}

// ── 獵人 ────────────────────────────────────────────────

async function triggerHunterShot(game, channel, client, hunter) {
  if (hunter.isBot) {
    const num = await AI.aiHunterShoot(hunter, game);
    if (num != null) {
      const t = game.getPlayerByNumber(num);
      if (t && t.alive) {
        t.alive = false;
        await channel.send({ embeds: [new EmbedBuilder().setColor(0x8B4513)
          .setTitle('🏹 獵人開槍！').setDescription(`${hunter.displayName} 帶走了 **${t.displayName}** (${ROLE_NAMES[t.role]})！`)] });
        if (game.checkWinCondition()) return endGame(game, channel, client);
      }
    }
    return startVote(game, channel, client);
  }

  await channel.send({ embeds: [new EmbedBuilder().setColor(0x8B4513)
    .setTitle('🏹 獵人出手！').setDescription(`**${hunter.displayName}** 是獵人！正在選擇開槍目標...`)] });

  try {
    const u = await client.users.fetch(hunter.id);
    await u.send({
      embeds: [new EmbedBuilder().setColor(0x8B4513).setTitle('🏹 你死了！選擇開槍目標').setDescription('請在 30 秒內選擇：')],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`hunter_shoot_${game.channelId}`).setPlaceholder('選擇開槍目標')
          .addOptions(game.alivePlayers.map(p => ({ label: `${p.number}. ${p.username}`, value: p.id })))
      )],
    });
  } catch (e) { console.error('私訊獵人失敗:', e.message); }

  game._hunterDead = hunter;
  game._hunterTimer = setTimeout(async () => {
    delete game._hunterTimer; delete game._hunterDead;
    await startVote(game, channel, client);
  }, 30_000);
}

export async function completeHunterShot(game, targetId, channel, client) {
  if (game._hunterTimer) { clearTimeout(game._hunterTimer); delete game._hunterTimer; }
  delete game._hunterDead;
  const t = game.getPlayer(targetId);
  if (t && t.alive) {
    t.alive = false;
    await channel.send({ embeds: [new EmbedBuilder().setColor(0x8B4513)
      .setTitle('🏹 獵人開槍！').setDescription(`獵人帶走了 **${t.displayName}** (${ROLE_NAMES[t.role]})！`)] });
    if (game.checkWinCondition()) return endGame(game, channel, client);
  }
  await startVote(game, channel, client);
}

// ── 投票 ────────────────────────────────────────────────

export async function startVote(game, channel, client) {
  game.phase = GAME_PHASE.VOTE;
  game.voteMap = new Map();

  const msg = await channel.send({
    embeds: [new EmbedBuilder().setColor(0xFF6B35)
      .setTitle(`${EMOJIS.VOTE} 投票放逐`).setDescription('請在 **60 秒**內投票！')
      .addFields({ name: '存活玩家', value: game.formatAlivePlayers() })],
    components: buildVoteComponents(game),
  });

  // AI 延遲 5 秒投票
  setTimeout(async () => {
    for (const bot of game.alivePlayers.filter(p => p.isBot)) {
      const num = await AI.aiVote(bot, game);
      if (num != null) {
        const t = game.getPlayerByNumber(num);
        if (t) game.voteMap.set(bot.id, t.id);
      }
    }
  }, 5_000);

  game._voteTimer = setTimeout(() => resolveVote(game, channel, client, msg), 60_000);
}

export async function registerVote(game, voterId, targetId, channel, client) {
  if (game.phase !== GAME_PHASE.VOTE) return;
  const voter = game.getPlayer(voterId);
  if (!voter || !voter.alive) return;
  game.voteMap.set(voterId, targetId);

  const aliveHumans = game.alivePlayers.filter(p => !p.isBot);
  if (aliveHumans.every(p => game.voteMap.has(p.id))) {
    clearTimeout(game._voteTimer);
    await resolveVote(game, channel, client, null);
  }
}

async function resolveVote(game, channel, client, voteMsg) {
  if (game.phase !== GAME_PHASE.VOTE) return;
  game.phase = GAME_PHASE.DAY;
  if (voteMsg) { try { await voteMsg.edit({ components: [] }); } catch (_) {} }

  const { executed, tied, tally } = game.resolveVote();

  let desc = '';
  if (tally?.size) {
    desc += [...tally.entries()]
      .map(([id, cnt]) => { const p = game.getPlayer(id); return p ? `${p.displayName}：${cnt}票` : ''; })
      .filter(Boolean).join('\n') + '\n\n';
  }
  desc += tied ? '票數相同，今日**無人被放逐**！'
    : executed ? `**${executed.displayName}** 被放逐！（${ROLE_NAMES[executed.role]}）`
    : '今日無人被放逐。';

  await channel.send({ embeds: [new EmbedBuilder().setColor(0xFF6B35)
    .setTitle(`${EMOJIS.VOTE} 投票結果`).setDescription(desc)] });

  if (game.checkWinCondition()) return endGame(game, channel, client);
  if (executed?.role === ROLES.HUNTER) return triggerHunterShot(game, channel, client, executed);

  await delay(3_000);
  await startNight(game, channel, client);
}

// ── 遊戲結束 ────────────────────────────────────────────

async function endGame(game, channel, client) {
  game.phase = GAME_PHASE.ENDED;
  const wolfWin = game.winner === TEAM.WEREWOLF;
  const allPlayers = [...game.players.values()]
    .map(p => `${p.alive ? '✅' : '💀'} ${p.displayName} — ${ROLE_NAMES[p.role]}`).join('\n');

  await channel.send({ embeds: [new EmbedBuilder()
    .setColor(wolfWin ? 0x8B0000 : 0x2E8B57)
    .setTitle(wolfWin ? `${EMOJIS.WOLF} 狼人獲勝！` : `${EMOJIS.WIN} 好人獲勝！`)
    .setDescription(wolfWin ? '狼人統治了村莊...' : '村民成功揪出所有狼人！')
    .addFields({ name: '最終結果', value: allPlayers })] });

  for (const player of game.players.values()) {
    if (!player.isBot) {
      try {
        const u = await client.users.fetch(player.id);
        const win = player.team === game.winner;
        await u.send({ embeds: [new EmbedBuilder()
          .setColor(win ? 0x2E8B57 : 0x8B0000)
          .setTitle(win ? '🎉 你贏了！' : '😢 你輸了...')
          .setDescription(`你的角色：${ROLE_NAMES[player.role]}\n${win ? '你的陣營獲勝！' : '你的陣營敗北。'}`)] });
      } catch (_) {}
    }
  }
  setTimeout(() => destroyGame(game.channelId), 5_000);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
