// GameEngine.js
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, StringSelectMenuBuilder, ChannelType,
  PermissionsBitField,
} from 'discord.js';
import { ROLES, ROLE_NAMES, TEAM, GAME_PHASE, EMOJIS } from './constants.js';
import { GameState } from './GameState.js';
import * as AI from './AIPlayer.js';

const games = new Map();
const seerMemory = new Map();

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

// ── 討論串管理 ──────────────────────────────────────────

async function createThread(channel, name, memberIds) {
  try {
    const thread = await channel.threads.create({
      name,
      type: ChannelType.PrivateThread,
      invitable: false,
    });
    for (const id of memberIds) {
      try { await thread.members.add(id); } catch (_) {}
    }
    return thread;
  } catch (e) {
    console.error(`建立討論串失敗 [${name}]:`, e.message);
    return null;
  }
}

async function deleteAllThreads(game) {
  if (!game.threads) return;
  for (const thread of game.threads.values()) {
    try { await thread.delete(); } catch (_) {}
  }
  game.threads = new Map();
}

function getThread(game, key) {
  return game.threads?.get(key) ?? null;
}

async function sendToThread(game, key, payload) {
  const thread = getThread(game, key);
  if (!thread) return;
  try { await thread.send(payload); } catch (e) { console.error(`討論串發訊失敗[${key}]:`, e.message); }
}

export async function setupThreads(game, channel, client) {
  game.threads = new Map();

  // 狼人共用密室
  const realWolves = game.aliveWolves.filter(p => !p.isBot);
  if (realWolves.length > 0) {
    const wolfThread = await createThread(channel, '🐺 狼人密室', realWolves.map(p => p.id));
    if (wolfThread) {
      game.threads.set('wolf_room', wolfThread);
      for (const w of realWolves) game.threads.set(w.id, wolfThread);
    }
  }

  // 神職個人密室
  const specials = game.alivePlayers.filter(p =>
    !p.isBot && [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER].includes(p.role)
  );
  for (const player of specials) {
    const thread = await createThread(channel, `${ROLE_NAMES[player.role]} ${player.username} 的密室`, [player.id]);
    if (thread) game.threads.set(player.id, thread);
  }

  // 平民個人密室（只收開局通知）
  const villagers = game.alivePlayers.filter(p => !p.isBot && p.role === ROLES.VILLAGER);
  for (const player of villagers) {
    const thread = await createThread(channel, `👤 ${player.username} 的密室`, [player.id]);
    if (thread) game.threads.set(player.id, thread);
  }
}

// ── 頻道發言權限控制 ────────────────────────────────────
// 記錄目前允許發言的玩家ID（null = 所有人都可以）
// game.speakingPlayerId = string | null

async function lockChannelForPlayer(game, channel, allowPlayerId) {
  // 記錄目前發言者
  game.speakingPlayerId = allowPlayerId;

  // 取得所有真人玩家的 Discord member
  const humanPlayers = game.alivePlayers.filter(p => !p.isBot);
  for (const player of humanPlayers) {
    try {
      const member = await channel.guild.members.fetch(player.id);
      if (player.id === allowPlayerId) {
        // 允許發言
        await channel.permissionOverwrites.edit(member, {
          SendMessages: true,
        });
      } else {
        // 禁止發言
        await channel.permissionOverwrites.edit(member, {
          SendMessages: false,
        });
      }
    } catch (e) { console.error(`權限設定失敗 ${player.username}:`, e.message); }
  }
}

async function unlockChannel(game, channel) {
  game.speakingPlayerId = null;
  const humanPlayers = [...game.players.values()].filter(p => !p.isBot);
  for (const player of humanPlayers) {
    try {
      const member = await channel.guild.members.fetch(player.id);
      await channel.permissionOverwrites.edit(member, {
        SendMessages: null, // 恢復預設
      });
    } catch (e) { console.error(`權限恢復失敗 ${player.username}:`, e.message); }
  }
}

// ── Embeds & Buttons ────────────────────────────────────

export function buildLobbyEmbed(game) {
  const playerList = game.players.size > 0
    ? [...game.players.values()].map(p => `${p.number}. ${p.displayName}`).join('\n')
    : '（尚無玩家）';
  const roleList = [...new Set(game.mode.roles)].map(r => ROLE_NAMES[r]).join(' | ');
  return new EmbedBuilder()
    .setColor(0x2B2D31)
    .setTitle(`${EMOJIS.VILLAGE} 狼人殺 — ${game.mode.name}`)
    .setDescription(`**勝利條件**：${game.mode.winCondition === 'kill_all_specials'
      ? '屠城局（狼人殺光所有好人=勝）' : '屠邊局（狼人殺光平民或神職其中一邊=勝）'}`)
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
      new ButtonBuilder()
        .setCustomId(`vote_${p.id}`)
        .setLabel(`${p.number}. ${p.username.substring(0, 12)}`)
        .setStyle(ButtonStyle.Secondary)
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

  // 夜晚鎖定頻道（所有玩家都不能發言）
  await lockChannelForPlayer(game, channel, null);

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x1a1a2e)
      .setTitle(`${EMOJIS.MOON} 第 ${game.day} 夜`)
      .setDescription('天黑請閉眼...\n請到你的**密室討論串**進行夜晚行動。')
      .addFields({ name: '存活玩家', value: game.formatPlayerList() })]
  });
  await delay(1500);
  await phaseWerewolf(game, channel, client);
}

// ── 狼人階段 ────────────────────────────────────────────

async function phaseWerewolf(game, channel, client) {
  const wolves = game.aliveWolves;
  const realWolves = wolves.filter(p => !p.isBot);
  const botWolves  = wolves.filter(p => p.isBot);

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
  const targets = game.alivePlayers.filter(p => p.team !== TEAM.WEREWOLF);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`wolf_kill_${game.channelId}`).setPlaceholder('選擇擊殺目標')
    .addOptions(targets.map(p => ({ label: `${p.number}. ${p.username}`, value: p.id })));

  await sendToThread(game, 'wolf_room', {
    embeds: [new EmbedBuilder().setColor(0x8B0000)
      .setTitle(`${EMOJIS.MOON} 狼人行動 — 第${game.day}夜`)
      .setDescription(`🐺 狼人同伴：**${wolfNames}**\n\n請在 **60 秒**內選擇今晚的擊殺目標（任一狼人選擇即可）：`)],
    components: [new ActionRowBuilder().addComponents(menu)],
  });

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
  const target = game.getPlayer(targetId);
  await sendToThread(game, 'wolf_room', {
    embeds: [new EmbedBuilder().setColor(0x8B0000)
      .setTitle('✅ 目標已選定')
      .setDescription(`今晚將擊殺：**${target?.displayName || '?'}**`)]
  });
  await phaseSeer(game, channel, client);
}

// ── 預言家階段 ──────────────────────────────────────────

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
    .map(([id, team]) => {
      const p = game.getPlayer(id);
      return p ? `${p.displayName}：${team === TEAM.WEREWOLF ? '🔴 狼人' : '🟢 好人'}` : '';
    }).filter(Boolean).join('\n') || '（尚未查驗）';

  const targets = game.alivePlayers.filter(p => p.id !== seer.id);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`seer_check_${game.channelId}`).setPlaceholder('選擇查驗對象')
    .addOptions(targets.map(p => ({ label: `${p.number}. ${p.username}`, value: p.id })));

  await sendToThread(game, seer.id, {
    embeds: [new EmbedBuilder().setColor(0x9B59B6)
      .setTitle(`${EMOJIS.MOON} 預言家行動 — 第${game.day}夜`)
      .setDescription(`**已查驗記錄：**\n${checkedInfo}\n\n請在 **60 秒**內選擇今晚要查驗的玩家：`)],
    components: [new ActionRowBuilder().addComponents(menu)],
  });

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
    const isWolf = target.team === TEAM.WEREWOLF;
    await sendToThread(game, seerId, {
      embeds: [new EmbedBuilder()
        .setColor(isWolf ? 0x8B0000 : 0x2E8B57)
        .setTitle('🔮 查驗結果')
        .setDescription(`**${target.displayName}** — ${isWolf ? '🔴 是【狼人】！' : '🟢 是【好人】。'}`)]
    });
  }
  await phaseWitch(game, channel, client);
}

// ── 女巫階段 ────────────────────────────────────────────

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
    await sendToThread(game, witch.id, {
      embeds: [new EmbedBuilder().setColor(0x8B008B)
        .setTitle(`${EMOJIS.MOON} 女巫行動 — 第${game.day}夜`)
        .setDescription('你的解藥和毒藥都已用完，今晚無法行動。')]
    });
    return resolveNight(game, channel, client);
  }

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

  await sendToThread(game, witch.id, {
    embeds: [new EmbedBuilder().setColor(0x8B008B)
      .setTitle(`${EMOJIS.MOON} 女巫行動 — 第${game.day}夜`).setDescription(desc)],
    components,
  });

  game._witchSaveDone   = !canSave;
  game._witchPoisonDone = !canPoison;
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

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0xFFD700)
      .setTitle(`${EMOJIS.SUN} 第 ${game.day} 天 — 天亮了`)
      .setDescription(deathMsg)
      .addFields({ name: '存活玩家', value: game.formatPlayerList() })]
  });

  for (const dead of deaths) {
    if (dead.role === ROLES.HUNTER) return triggerHunterShot(game, channel, client, dead);
  }

  await startDiscussion(game, channel, client);
}

// ── 白天輪流發言 ─────────────────────────────────────────

async function startDiscussion(game, channel, client) {
  game.phase = GAME_PHASE.DAY;
  game.discussionHistory = []; // 本輪發言紀錄

  // 建立發言順序：先存活真人，再存活AI，隨機打亂
  const humanPlayers = game.alivePlayers.filter(p => !p.isBot);
  const botPlayers   = game.alivePlayers.filter(p => p.isBot);
  const speakOrder = [
    ...humanPlayers.sort(() => Math.random() - 0.5),
    ...botPlayers.sort(() => Math.random() - 0.5),
  ];

  game.speakOrder = speakOrder;
  game.speakIndex = 0;

  const orderText = speakOrder.map((p, i) => `${i + 1}. ${p.displayName}`).join('\n');

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x5865F2)
      .setTitle('💬 白天討論開始')
      .setDescription('每位玩家輪流發言，每人 **50 秒**，請說出你的看法！')
      .addFields({ name: '發言順序', value: orderText })]
  });

  await delay(2000);
  await runNextSpeaker(game, channel, client);
}

async function runNextSpeaker(game, channel, client) {
  if (game.speakIndex >= game.speakOrder.length) {
    // 所有人都發言完畢，解鎖頻道，進入投票
    await unlockChannel(game, channel);
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x5865F2)
        .setTitle('💬 討論結束')
        .setDescription('所有人發言完畢！進入投票階段...')]
    });
    await delay(3000);
    return startVote(game, channel, client);
  }

  const speaker = game.speakOrder[game.speakIndex];
  const remaining = game.speakOrder.length - game.speakIndex;

  if (speaker.isBot) {
    // AI 玩家發言
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x5865F2)
        .setTitle(`💬 輪到 ${speaker.displayName} 發言`)
        .setDescription('AI 正在思考...')]
    });

    await delay(3000); // 模擬思考，同時避免 API 限流
    const speech = await AI.aiDaySpeak(speaker, game, game.discussionHistory);
    game.discussionHistory.push({ name: speaker.displayName, content: speech });

    await channel.send(`🤖 **${speaker.displayName}**：${speech}`);
    await delay(4000); // AI 發言後等待，避免連續呼叫超過限流

    game.speakIndex++;
    await runNextSpeaker(game, channel, client);

  } else {
    // 真人玩家發言：鎖定頻道，只有此玩家可以發言
    await lockChannelForPlayer(game, channel, speaker.id);

    const timerMsg = await channel.send({
      embeds: [new EmbedBuilder().setColor(0x5865F2)
        .setTitle(`💬 輪到 ${speaker.displayName} 發言`)
        .setDescription(`<@${speaker.id}> 請在 **50 秒**內發言！\n剩餘 ${remaining} 人未發言。`)
        .setFooter({ text: '發言後Bot會自動進入下一位，或50秒後自動跳過' })]
    });

    // 50 秒計時
    game._speakTimer = setTimeout(async () => {
      delete game._speakTimer;
      game.discussionHistory.push({ name: speaker.displayName, content: '（跳過發言）' });
      try { await timerMsg.edit({
        embeds: [new EmbedBuilder().setColor(0x888888)
          .setTitle(`⏭️ ${speaker.displayName} 發言時間結束，自動跳過`)]
      }); } catch (_) {}
      game.speakIndex++;
      await runNextSpeaker(game, channel, client);
    }, 50_000);

    // 等待玩家發言（由 handlePlayerSpeak 觸發）
    game._currentSpeaker = speaker;
  }
}

// 由 index.js 呼叫：玩家在頻道發言時觸發
export async function handlePlayerSpeak(game, message, channel, client) {
  if (game.phase !== GAME_PHASE.DAY) return;
  if (!game._currentSpeaker) return;
  if (message.author.id !== game._currentSpeaker.id) return;

  // 清除計時
  if (game._speakTimer) { clearTimeout(game._speakTimer); delete game._speakTimer; }

  // 記錄發言
  game.discussionHistory.push({
    name: game._currentSpeaker.displayName,
    content: message.content,
  });

  delete game._currentSpeaker;
  game.speakIndex++;

  await delay(1500);
  await runNextSpeaker(game, channel, client);
}

// ── 獵人 ────────────────────────────────────────────────

async function triggerHunterShot(game, channel, client, hunter) {
  if (hunter.isBot) {
    const num = await AI.aiHunterShoot(hunter, game);
    if (num != null) {
      const t = game.getPlayerByNumber(num);
      if (t && t.alive) {
        t.alive = false;
        await channel.send({
          embeds: [new EmbedBuilder().setColor(0x8B4513)
            .setTitle('🏹 獵人開槍！')
            .setDescription(`${hunter.displayName} 帶走了 **${t.displayName}** (${ROLE_NAMES[t.role]})！`)]
        });
        if (game.checkWinCondition()) return endGame(game, channel, client);
      }
    }
    return startDiscussion(game, channel, client);
  }

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x8B4513)
      .setTitle('🏹 獵人出手！')
      .setDescription(`**${hunter.displayName}** 是獵人！請到密室選擇開槍目標...`)]
  });

  const targets = game.alivePlayers;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hunter_shoot_${game.channelId}`).setPlaceholder('選擇開槍目標')
    .addOptions(targets.map(p => ({ label: `${p.number}. ${p.username}`, value: p.id })));

  await sendToThread(game, hunter.id, {
    embeds: [new EmbedBuilder().setColor(0x8B4513)
      .setTitle('🏹 你死了！可以開槍帶走一人')
      .setDescription('請在 **30 秒**內選擇目標：')],
    components: [new ActionRowBuilder().addComponents(menu)],
  });

  game._hunterDead = hunter;
  game._hunterTimer = setTimeout(async () => {
    delete game._hunterTimer; delete game._hunterDead;
    await startDiscussion(game, channel, client);
  }, 30_000);
}

export async function completeHunterShot(game, targetId, channel, client) {
  if (game._hunterTimer) { clearTimeout(game._hunterTimer); delete game._hunterTimer; }
  delete game._hunterDead;
  const t = game.getPlayer(targetId);
  if (t && t.alive) {
    t.alive = false;
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x8B4513)
        .setTitle('🏹 獵人開槍！')
        .setDescription(`獵人帶走了 **${t.displayName}** (${ROLE_NAMES[t.role]})！`)]
    });
    if (game.checkWinCondition()) return endGame(game, channel, client);
  }
  await startDiscussion(game, channel, client);
}

// ── 投票 ────────────────────────────────────────────────

export async function startVote(game, channel, client) {
  game.phase = GAME_PHASE.VOTE;
  game.voteMap = new Map();

  // 投票期間解鎖頻道讓所有人可以投票
  await unlockChannel(game, channel);

  const msg = await channel.send({
    embeds: [new EmbedBuilder().setColor(0xFF6B35)
      .setTitle(`${EMOJIS.VOTE} 投票放逐`)
      .setDescription('請在 **60 秒**內投票！所有人投完提前結算。')
      .addFields({ name: '存活玩家', value: game.formatAlivePlayers() })],
    components: buildVoteComponents(game),
  });

  // AI 玩家 5 秒後投票
  setTimeout(async () => {
    for (const bot of game.alivePlayers.filter(p => p.isBot)) {
      const num = await AI.aiVote(bot, game);
      if (num != null) {
        const t = game.getPlayerByNumber(num);
        if (t) game.voteMap.set(bot.id, t.id);
      }
    }
    const aliveHumans = game.alivePlayers.filter(p => !p.isBot);
    if (aliveHumans.every(p => game.voteMap.has(p.id))) {
      clearTimeout(game._voteTimer);
      await resolveVote(game, channel, client, msg);
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
  desc += tied
    ? '票數相同，今日**無人被放逐**！'
    : executed
      ? `**${executed.displayName}** 被放逐！（${ROLE_NAMES[executed.role]}）`
      : '今日無人被放逐。';

  await channel.send({
    embeds: [new EmbedBuilder().setColor(0xFF6B35)
      .setTitle(`${EMOJIS.VOTE} 投票結果`).setDescription(desc)]
  });

  if (game.checkWinCondition()) return endGame(game, channel, client);
  if (executed?.role === ROLES.HUNTER) return triggerHunterShot(game, channel, client, executed);

  await delay(3_000);
  await startNight(game, channel, client);
}

// ── 遊戲結束 ────────────────────────────────────────────

async function endGame(game, channel, client) {
  game.phase = GAME_PHASE.ENDED;

  // 解鎖頻道
  await unlockChannel(game, channel);

  const wolfWin = game.winner === TEAM.WEREWOLF;
  const allPlayers = [...game.players.values()]
    .map(p => `${p.alive ? '✅' : '💀'} ${p.displayName} — ${ROLE_NAMES[p.role]}`).join('\n');

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(wolfWin ? 0x8B0000 : 0x2E8B57)
      .setTitle(wolfWin ? `${EMOJIS.WOLF} 狼人獲勝！` : `${EMOJIS.WIN} 好人獲勝！`)
      .setDescription(wolfWin ? '狼人統治了村莊...' : '村民成功揪出所有狼人！')
      .addFields({ name: '最終結果', value: allPlayers })]
  });

  // 通知狼人密室
  const wolfWinMsg = wolfWin ? '🎉 你贏了！' : '😢 你輸了...';
  await sendToThread(game, 'wolf_room', {
    embeds: [new EmbedBuilder()
      .setColor(wolfWin ? 0x2E8B57 : 0x8B0000)
      .setTitle(wolfWin ? '🎉 你贏了！' : '😢 你輸了...')
      .setDescription(`狼人陣營${wolfWin ? '獲勝！' : '敗北。'}`)]
  });

  // 通知其他玩家密室
  for (const player of game.players.values()) {
    if (!player.isBot && player.role !== ROLES.WEREWOLF) {
      const win = player.team === game.winner;
      await sendToThread(game, player.id, {
        embeds: [new EmbedBuilder()
          .setColor(win ? 0x2E8B57 : 0x8B0000)
          .setTitle(win ? '🎉 你贏了！' : '😢 你輸了...')
          .setDescription(`你的角色：${ROLE_NAMES[player.role]}\n${win ? '你的陣營獲勝！' : '你的陣營敗北。'}`)]
      });
    }
  }

  setTimeout(async () => {
    await deleteAllThreads(game);
    destroyGame(game.channelId);
  }, 10_000);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
