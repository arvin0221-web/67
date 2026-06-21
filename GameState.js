// GameState.js
import { ROLES, ROLE_NAMES, ROLE_TEAM, TEAM, MODE_6, MODE_9, GAME_PHASE, EMOJIS } from './constants.js';

export class Player {
  constructor(id, username, isBot = false) {
    this.id = id;
    this.username = username;
    this.isBot = isBot;
    this.role = null;
    this.alive = true;
    this.protected = false;
    this.number = 0;
  }

  get displayName() {
    return this.isBot ? `🤖${this.username}` : this.username;
  }

  get team() {
    return ROLE_TEAM[this.role];
  }
}

export class GameState {
  constructor(channelId, mode) {
    this.channelId = channelId;
    this.mode = mode === 6 ? MODE_6 : MODE_9;
    this.players = new Map();
    this.phase = GAME_PHASE.WAITING;
    this.day = 0;
    this.wolfTarget = null;
    this.witchSaveUsed = false;
    this.witchPoisonUsed = false;
    this.witchPoisonTarget = null;
    this.voteMap = new Map();
    this.winner = null;
    this.log = [];
  }

  addLog(msg) {
    this.log.push(`[第${this.day}天] ${msg}`);
  }

  get alivePlayers() {
    return [...this.players.values()].filter(p => p.alive);
  }

  get aliveWolves() {
    return this.alivePlayers.filter(p => p.role === ROLES.WEREWOLF);
  }

  get aliveVillagers() {
    return this.alivePlayers.filter(p => p.team === TEAM.VILLAGER);
  }

  get aliveSpecials() {
    return this.alivePlayers.filter(p =>
      [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER].includes(p.role)
    );
  }

  getPlayer(userId) {
    return this.players.get(userId);
  }

  getPlayerByNumber(num) {
    return [...this.players.values()].find(p => p.number === num);
  }

  addPlayer(userId, username, isBot = false) {
    if (this.players.size >= this.mode.total) return false;
    const player = new Player(userId, username, isBot);
    player.number = this.players.size + 1;
    this.players.set(userId, player);
    return true;
  }

  assignRoles() {
    const roles = [...this.mode.roles].sort(() => Math.random() - 0.5);
    let i = 0;
    for (const player of this.players.values()) {
      player.role = roles[i++];
    }
  }

  resolveNight() {
    const dead = [];

    if (this.wolfTarget) {
      const target = this.getPlayer(this.wolfTarget);
      if (target && target.alive && !target.protected) {
        target.alive = false;
        dead.push(target);
        this.addLog(`${target.displayName} 被狼人殺死`);
      }
      this.wolfTarget = null;
    }

    if (this.witchPoisonTarget) {
      const target = this.getPlayer(this.witchPoisonTarget);
      if (target && target.alive) {
        target.alive = false;
        dead.push(target);
        this.addLog(`${target.displayName} 被女巫毒死`);
      }
      this.witchPoisonTarget = null;
    }

    for (const p of this.players.values()) {
      p.protected = false;
    }

    return dead;
  }

  resolveVote() {
    const tally = new Map();
    for (const targetId of this.voteMap.values()) {
      tally.set(targetId, (tally.get(targetId) || 0) + 1);
    }

    if (tally.size === 0) return { executed: null, tied: false, tally };

    const maxVotes = Math.max(...tally.values());
    const top = [...tally.entries()].filter(([, v]) => v === maxVotes);

    if (top.length > 1) return { executed: null, tied: true, tally };

    const [executedId] = top[0];
    const executed = this.getPlayer(executedId);
    if (executed && executed.alive) {
      executed.alive = false;
      this.addLog(`${executed.displayName} 被投票放逐`);
    }

    return { executed, tied: false, tally };
  }

  checkWinCondition() {
    const wolves = this.aliveWolves.length;
    const villagers = this.aliveVillagers.length;
    const specials = this.aliveSpecials.length;

    if (wolves === 0) {
      this.winner = TEAM.VILLAGER;
      return true;
    }

    if (this.mode.winCondition === 'kill_all_specials') {
      // 屠城局：狼人數量 >= 好人數量即勝（好人被殺到剩下跟狼人一樣多就輸）
      if (wolves >= villagers) {
        this.winner = TEAM.WEREWOLF;
        return true;
      }
    } else {
      const plainVillagers = this.alivePlayers.filter(p => p.role === ROLES.VILLAGER).length;
      if (wolves >= villagers || plainVillagers === 0 || specials === 0) {
        this.winner = TEAM.WEREWOLF;
        return true;
      }
    }

    return false;
  }

  formatPlayerList() {
    return [...this.players.values()]
      .map(p => `${p.alive ? '✅' : '💀'} **${p.number}.** ${p.displayName}`)
      .join('\n');
  }

  formatAlivePlayers() {
    return this.alivePlayers
      .map(p => `**${p.number}.** ${p.displayName}`)
      .join('\n');
  }
}
