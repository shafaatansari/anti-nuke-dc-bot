require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  PermissionsBitField,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");

const play = require("@iamtraction/play-dl");
const Database = require("better-sqlite3");

let config = {};
try {
  config = require("./config");
} catch {
  config = {};
}

/* =========================
   ENV
========================= */

for (const key of ["DISCORD_TOKEN", "CLIENT_ID", "OWNER_ID"]) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key} in .env`);
  }
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;

/* =========================
   CLIENT
========================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

/* =========================
   DATABASE
========================= */

const db = new Database("antinuke.sqlite");

db.pragma("journal_mode=WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    log_channel_id TEXT,
    welcome_channel_id TEXT,
    lockdown INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS whitelist (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
`);

/* Existing database compatibility */

try {
  db.prepare("SELECT welcome_channel_id FROM guilds LIMIT 1").get();
} catch {
  try {
    db.exec("ALTER TABLE guilds ADD COLUMN welcome_channel_id TEXT");
  } catch {}
}

/* =========================
   ANTI-NUKE DATA
========================= */

const counters = new Map();
const cooldown = new Map();

/* =========================
   MUSIC
========================= */

const musicQueues = new Map();

function getQueue(guildId) {
  if (!musicQueues.has(guildId)) {
    const player = createAudioPlayer();

    const queue = {
      songs: [],
      player,
      connection: null,
      playing: false,
    };

    /*
      IMPORTANT:
      When a song naturally finishes, remove it
      before playing the next song.
    */
    player.on(AudioPlayerStatus.Idle, async () => {
      if (queue.songs.length > 0) {
        queue.songs.shift();
      }

      queue.playing = false;

      await playNext(guildId);
    });

    player.on("error", async (error) => {
      console.error("Music player error:", error.message);

      if (queue.songs.length > 0) {
        queue.songs.shift();
      }

      queue.playing = false;

      await playNext(guildId);
    });

    musicQueues.set(guildId, queue);
  }

  return musicQueues.get(guildId);
}

/* =========================
   SLASH COMMANDS
========================= */

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup anti-nuke log channel")
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("Log channel")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("welcome-setup")
    .setDescription("Setup welcome channel")
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("Welcome channel")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("whitelist")
    .setDescription("Whitelist a user")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("User to whitelist")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("unwhitelist")
    .setDescription("Remove user from whitelist")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("User to remove")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("whitelist-list")
    .setDescription("Show whitelist"),

  new SlashCommandBuilder()
    .setName("lockdown")
    .setDescription("Enable server lockdown"),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Disable server lockdown"),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Show anti-nuke configuration"),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a YouTube song")
    .addStringOption(option =>
      option
        .setName("query")
        .setDescription("Song name or YouTube URL")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip current song"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop music and clear queue"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause current song"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume current song"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show music queue"),
].map(command => command.toJSON());

/* =========================
   DATABASE HELPERS
========================= */

function ensureGuild(guildId) {
  db.prepare(`
    INSERT OR IGNORE INTO guilds
    (guild_id, log_channel_id, welcome_channel_id, lockdown)
    VALUES (?, NULL, NULL, 0)
  `).run(guildId);
}

function isTrusted(guildId, userId) {
  if (userId === OWNER_ID) return true;

  const row = db
    .prepare(
      "SELECT user_id FROM whitelist WHERE guild_id = ? AND user_id = ?"
    )
    .get(guildId, userId);

  return !!row;
}

function getLogChannelId(guildId) {
  ensureGuild(guildId);

  const row = db
    .prepare("SELECT log_channel_id FROM guilds WHERE guild_id = ?")
    .get(guildId);

  return row?.log_channel_id || null;
}

function getWelcomeChannelId(guildId) {
  ensureGuild(guildId);

  const row = db
    .prepare("SELECT welcome_channel_id FROM guilds WHERE guild_id = ?")
    .get(guildId);

  return row?.welcome_channel_id || null;
}

/* =========================
   LOGGING
========================= */

async function sendLog(guild, message) {
  try {
    const channelId = getLogChannelId(guild.id);

    if (!channelId) return;

    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (!channel || !channel.isTextBased()) return;

    await channel.send(message).catch(() => {});
  } catch (error) {
    console.error("Log error:", error.message);
  }
}

/* =========================
   WELCOME
========================= */

client.on("guildMemberAdd", async member => {
  try {
    ensureGuild(member.guild.id);

    const welcomeChannelId = getWelcomeChannelId(member.guild.id);

    if (welcomeChannelId) {
      const channel = await member.guild.channels
        .fetch(welcomeChannelId)
        .catch(() => null);

      if (channel && channel.isTextBased()) {
        await channel.send(
          `👋 Welcome ${member}!\n` +
          `🎉 Welcome to **${member.guild.name}**!\n` +
          `👥 You are member **#${member.guild.memberCount}**.`
        );
      }
    }
  } catch (error) {
    console.error("Welcome error:", error.message);
  }

  /*
    Anti-nuke bot-add detection
  */

  try {
    const executor = await getExecutor(
      member.guild,
      AuditLogEvent.BotAdd,
      member.id
    );

    if (!executor) return;

    if (executor.id === client.user.id) return;

    if (isTrusted(member.guild.id, executor.id)) return;

    await punish(
      member.guild,
      executor.id,
      `Unauthorized bot added by <@${executor.id}>`
    );
  } catch (error) {
    console.error("Bot add protection error:", error.message);
  }
});

/* =========================
   ANTI-NUKE COUNTER
========================= */

function countAction(guildId, userId, action) {
  const key = `${guildId}:${userId}:${action}`;

  const now = Date.now();

  const current = counters.get(key) || [];

  const filtered = current.filter(time => now - time < 10000);

  filtered.push(now);

  counters.set(key, filtered);

  /*
    Default threshold = 3 actions / 10 seconds
  */

  const threshold =
    Number(config?.thresholds?.[action]) ||
    Number(config?.threshold) ||
    3;

  return filtered.length >= threshold;
}

/* =========================
   AUDIT LOG
========================= */

async function getExecutor(guild, type, targetId = null) {
  try {
    const logs = await guild.fetchAuditLogs({
      type,
      limit: 10,
    });

    const entry = logs.entries.find(entry => {
      if (Date.now() - entry.createdTimestamp > 10000) {
        return false;
      }

      if (targetId && entry.target?.id !== targetId) {
        return false;
      }

      return true;
    });

    return entry?.executor || null;
  } catch (error) {
    console.error("Audit log error:", error.message);
    return null;
  }
}

/* =========================
   LOCKDOWN
========================= */

async function lockdown(guild, reason = "Anti-nuke lockdown") {
  try {
    ensureGuild(guild.id);

    db.prepare(
      "UPDATE guilds SET lockdown = 1 WHERE guild_id = ?"
    ).run(guild.id);

    for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased()) continue;

      if (!channel.permissionOverwrites) continue;

      try {
        await channel.permissionOverwrites.edit(
          guild.roles.everyone,
          {
            SendMessages: false,
          },
          {
            reason,
          }
        );
      } catch {}
    }

    await sendLog(
      guild,
      `🔒 **SERVER LOCKDOWN ENABLED**\nReason: ${reason}`
    );

    return true;
  } catch (error) {
    console.error("Lockdown error:", error.message);
    return false;
  }
}

/* =========================
   UNLOCK
========================= */

async function unlockServer(guild) {
  try {
    ensureGuild(guild.id);

    db.prepare(
      "UPDATE guilds SET lockdown = 0 WHERE guild_id = ?"
    ).run(guild.id);

    for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased()) continue;

      if (!channel.permissionOverwrites) continue;

      try {
        await channel.permissionOverwrites.edit(
          guild.roles.everyone,
          {
            SendMessages: null,
          },
          {
            reason: "Manual server unlock",
          }
        );
      } catch {}
    }

    await sendLog(
      guild,
      `🔓 **SERVER LOCKDOWN DISABLED**`
    );

    return true;
  } catch (error) {
    console.error("Unlock error:", error.message);
    return false;
  }
}

/* =========================
   PUNISH
========================= */

async function punish(guild, userId, reason) {
  try {
    if (cooldown.has(`${guild.id}:${userId}`)) {
      return;
    }

    cooldown.set(`${guild.id}:${userId}`, Date.now());

    setTimeout(() => {
      cooldown.delete(`${guild.id}:${userId}`);
    }, 30000);

    const member = await guild.members
      .fetch(userId)
      .catch(() => null);

    if (member) {
      /*
        Remove roles that the bot can manage.
      */

      const removableRoles = member.roles.cache.filter(
        role =>
          role.id !== guild.id &&
          role.editable &&
          !role.managed
      );

      if (removableRoles.size > 0) {
        await member.roles
          .remove(
            removableRoles,
            "Anti-Nuke unauthorized action"
          )
          .catch(() => {});
      }
    }

    await sendLog(
      guild,
      `🚨 **ANTI-NUKE TRIGGERED**\n` +
      `👤 User: <@${userId}>\n` +
      `📌 Reason: ${reason}`
    );

    await lockdown(guild, reason);
  } catch (error) {
    console.error("Punish error:", error.message);
  }
}

/* =========================
   ANTI-NUKE INSPECT
========================= */

async function inspect(
  guild,
  userId,
  action,
  reason
) {
  if (!userId) return;

  if (userId === client.user.id) return;

  if (isTrusted(guild.id, userId)) return;

  const triggered = countAction(
    guild.id,
    userId,
    action
  );

  if (triggered) {
    await punish(
      guild,
      userId,
      reason
    );
  }
}

/* =========================
   MUSIC - PLAY NEXT
========================= */

async function playNext(guildId) {
  const queue = musicQueues.get(guildId);

  if (!queue) return;

  if (!queue.songs.length) {
    queue.playing = false;

    if (queue.connection) {
      try {
        queue.connection.destroy();
      } catch {}
    }

    queue.connection = null;

    return;
  }

  const song = queue.songs[0];

  try {
    if (!queue.connection) {
      queue.playing = false;
      return;
    }

    /*
      Get YouTube stream
    */

    const stream = await play.stream(song.url, {
      discordPlayerCompatibility: true,
    });

    const resource = createAudioResource(
      stream.stream,
      {
        inputType: stream.type,
        inlineVolume: true,
      }
    );

    if (resource.volume) {
      resource.volume.setVolume(0.5);
    }

    queue.connection.subscribe(queue.player);

    queue.player.play(resource);

    queue.playing = true;

    console.log(`🎵 Playing: ${song.title}`);
  } catch (error) {
    console.error(
      "Music stream error:",
      error.message
    );

    /*
      Remove broken song and continue.
    */

    if (queue.songs.length > 0) {
      queue.songs.shift();
    }

    queue.playing = false;

    await playNext(guildId);
  }
}

/* =========================
   CONNECT TO VOICE
========================= */

async function connectToVoice(interaction) {
  const member = interaction.member;

  if (!member?.voice?.channel) {
    throw new Error(
      "Pehle kisi voice channel mein join karo."
    );
  }

  const voiceChannel = member.voice.channel;

  const permissions =
    voiceChannel.permissionsFor(
      interaction.guild.members.me
    );

  if (
    !permissions?.has(
      PermissionsBitField.Flags.Connect
    )
  ) {
    throw new Error(
      "Bot ke paas voice channel mein **Connect** permission nahi hai."
    );
  }

  if (
    !permissions?.has(
      PermissionsBitField.Flags.Speak
    )
  ) {
    throw new Error(
      "Bot ke paas voice channel mein **Speak** permission nahi hai."
    );
  }

  const queue = getQueue(
    interaction.guild.id
  );

  /*
    Already connected
  */

  if (
    queue.connection &&
    queue.connection.joinConfig.channelId ===
      voiceChannel.id
  ) {
    return queue;
  }

  /*
    Destroy old connection
  */

  if (queue.connection) {
    try {
      queue.connection.destroy();
    } catch {}
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guild.id,
    adapterCreator:
      interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  queue.connection = connection;

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      15000
    );
  } catch (error) {
    try {
      connection.destroy();
    } catch {}

    queue.connection = null;

    throw new Error(
      "Voice channel se connect nahi ho paya."
    );
  }

  return queue;
}

/* =========================
   MUSIC SEARCH
========================= */

async function searchSong(query) {
  query = query.trim();

  if (!query) {
    throw new Error(
      "Song name ya YouTube URL do."
    );
  }

  /*
    Direct YouTube URL
  */

  if (play.yt_validate(query) === "video") {
    const info = await play.video_info(query);

    return {
      title:
        info.video_details?.title ||
        "Unknown YouTube Song",
      url: query,
    };
  }

  /*
    Search YouTube
  */

  const results = await play.search(
    query,
    {
      limit: 1,
      source: {
        youtube: "video",
      },
    }
  );

  if (!results || !results.length) {
    throw new Error(
      "YouTube par song nahi mila."
    );
  }

  return {
    title:
      results[0].title ||
      "Unknown Song",
    url: results[0].url,
  };
}

/* =========================
   READY
========================= */

client.once("ready", async () => {
  console.log(
    `✅ Logged in as ${client.user.tag}`
  );

  console.log(
    `🌐 Servers: ${client.guilds.cache.size}`
  );

  try {
    const rest = new REST({
      version: "10",
    }).setToken(TOKEN);

    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(
          CLIENT_ID,
          process.env.GUILD_ID
        )
      : Routes.applicationCommands(
          CLIENT_ID
        );

    await rest.put(route, {
      body: commands,
    });

    console.log(
      "✅ Slash commands registered."
    );
  } catch (error) {
    console.error(
      "Command registration error:",
      error.message
    );
  }

  console.log(
    "🛡️ Anti-Nuke V2 active."
  );

  console.log(
    "👋 Welcome system active."
  );

  console.log(
    "🎵 Music system active."
  );
});

/* =========================
   INTERACTIONS
========================= */

client.on(
  "interactionCreate",
  async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      ensureGuild(interaction.guild.id);

      const command =
        interaction.commandName;

      /* =====================
         ADMIN CHECK
      ===================== */

      const isAdmin =
        interaction.memberPermissions?.has(
          PermissionsBitField.Flags.Administrator
        );

      const isOwner =
        interaction.user.id === OWNER_ID;

      /* =====================
         SETUP
      ===================== */

      if (command === "setup") {
        if (!isAdmin && !isOwner) {
          return interaction.reply({
            content:
              "❌ Administrator permission required.",
            ephemeral: true,
          });
        }

        const channel =
          interaction.options.getChannel(
            "channel"
          );

        db.prepare(`
          UPDATE guilds
          SET log_channel_id = ?
          WHERE guild_id = ?
        `).run(
          channel.id,
          interaction.guild.id
        );

        return interaction.reply(
          `✅ Anti-nuke log channel set to ${channel}.`
        );
      }

      /* =====================
         WELCOME SETUP
      ===================== */

      if (command === "welcome-setup") {
        if (!isAdmin && !isOwner) {
          return interaction.reply({
            content:
              "❌ Administrator permission required.",
            ephemeral: true,
          });
        }

        const channel =
          interaction.options.getChannel(
            "channel"
          );

        db.prepare(`
          UPDATE guilds
          SET welcome_channel_id = ?
          WHERE guild_id = ?
        `).run(
          channel.id,
          interaction.guild.id
        );

        return interaction.reply(
          `✅ Welcome channel set to ${channel}.`
        );
      }

      /* =====================
         WHITELIST
      ===================== */

      if (command === "whitelist") {
        if (!isAdmin && !isOwner) {
          return interaction.reply({
            content:
              "❌ Administrator permission required.",
            ephemeral: true,
          });
        }

        const user =
          interaction.options.getUser(
            "user"
          );

        db.prepare(`
          INSERT OR IGNORE INTO whitelist
          (guild_id, user_id)
          VALUES (?, ?)
        `).run(
          interaction.guild.id,
          user.id
        );

        return interaction.reply(
          `✅ ${user} has been whitelisted.`
        );
      }

      /* =====================
         UNWHITELIST
      ===================== */

      if (command === "unwhitelist") {
        if (!isAdmin && !isOwner) {
          return interaction.reply({
            content:
              "❌ Administrator permission required.",
            ephemeral: true,
          });
        }

        const user =
          interaction.options.getUser(
            "user"
          );

        db.prepare(`
          DELETE FROM whitelist
          WHERE guild_id = ?
          AND user_id = ?
        `).run(
          interaction.guild.id,
          user.id
        );

        return interaction.reply(
          `✅ ${user} removed from whitelist.`
        );
      }

      /* =====================
         WHITELIST LIST
      ===================== */

      if (command === "whitelist-list") {
        if (!isAdmin && !isOwner) {
          return interaction.reply({
            content:
              "❌ Administrator permission required.",
            ephemeral: true,
          });
        }

        const rows =
          db.prepare(`
            SELECT user_id
            FROM whitelist
            WHERE guild_id = ?
          `).all(
            interaction.guild.id
          );

        if (!rows.length) {
          return interaction.reply(
            "📋 Whitelist empty."
          );
        }

        const list = rows
          .map(
            (row, index) =>
              `${index + 1}. <@${row.user_id}>`
          )
          .join("\n");

        return interaction.reply(
          `📋 **Whitelist**\n\n${list}`
        );
      }

      /* =====================
         LOCKDOWN
      ===================== */

      if (command === "lockdown") {
        if (!isAdmin && !isOwner) {
          return interaction.reply({
            content:
              "❌ Administrator permission required.",
            ephemeral: true,
          });
        }

        await lockdown(
          interaction.guild,
          "Manual lockdown"
        );

        return interaction.reply(
          "🔒 Server lockdown enabled."
        );
      }

      /* =====================
         UNLOCK
      ===================== */

      if (command === "unlock") {
        if (!isAdmin && !isOwner) {
          return interaction.reply({
            content:
              "❌ Administrator permission required.",
            ephemeral: true,
          });
        }

        await unlockServer(
          interaction.guild
        );

        return interaction.reply(
          "🔓 Server unlocked."
        );
      }

      /* =====================
         CONFIG
      ===================== */

      if (command === "config") {
        if (!isAdmin && !isOwner) {
          return interaction.reply({
            content:
              "❌ Administrator permission required.",
            ephemeral: true,
          });
        }

        const row =
          db.prepare(`
            SELECT *
            FROM guilds
            WHERE guild_id = ?
          `).get(
            interaction.guild.id
          );

        return interaction.reply(
          `⚙️ **Anti-Nuke Configuration**\n\n` +
          `📝 Log Channel: ${
            row?.log_channel_id
              ? `<#${row.log_channel_id}>`
              : "Not set"
          }\n` +
          `👋 Welcome Channel: ${
            row?.welcome_channel_id
              ? `<#${row.welcome_channel_id}>`
              : "Not set"
          }\n` +
          `🔒 Lockdown: ${
            row?.lockdown ? "ON" : "OFF"
          }\n` +
          `🛡️ Threshold: ${
            config?.threshold ||
            3
          } actions / 10 seconds`
        );
      }

      /* =====================
         PLAY
      ===================== */

      if (command === "play") {
        /*
          THIS IS THE IMPORTANT FIX.

          Discord gives slash commands only a few
          seconds to receive the first response.

          Search/YouTube operations can take longer,
          so defer first.
        */

        await interaction.deferReply();

        try {
          const query =
            interaction.options.getString(
              "query"
            );

          if (!query) {
            return interaction.editReply(
              "❌ Song name ya YouTube URL do."
            );
          }

          const queue =
            await connectToVoice(
              interaction
            );

          const song =
            await searchSong(query);

          queue.songs.push(song);

          /*
            If nothing is playing,
            start immediately.
          */

          if (!queue.playing) {
            await playNext(
              interaction.guild.id
            );
          }

          const position =
            queue.songs.length;

          return interaction.editReply(
            `🎵 **${song.title}**\n` +
            `✅ Queue mein add ho gaya.\n` +
            `📍 Position: **${position}**`
          );
        } catch (error) {
          console.error(
            "PLAY COMMAND ERROR:",
            error
          );

          return interaction.editReply(
            `❌ ${
              error.message ||
              "Music play karte waqt error aa gaya."
            }`
          );
        }
      }

      /* =====================
         SKIP
      ===================== */

      if (command === "skip") {
        const queue =
          musicQueues.get(
            interaction.guild.id
          );

        if (
          !queue ||
          !queue.songs.length
        ) {
          return interaction.reply(
            "❌ Queue empty hai."
          );
        }

        /*
          Remove current song.
        */

        queue.songs.shift();

        queue.playing = false;

        queue.player.stop();

        /*
          Idle event will start next song.
        */

        return interaction.reply(
          "⏭️ Song skipped."
        );
      }

      /* =====================
         STOP
      ===================== */

      if (command === "stop") {
        const queue =
          musicQueues.get(
            interaction.guild.id
          );

        if (!queue) {
          return interaction.reply(
            "❌ Music player active nahi hai."
          );
        }

        queue.songs = [];

        queue.playing = false;

        queue.player.stop();

        if (queue.connection) {
          try {
            queue.connection.destroy();
          } catch {}
        }

        queue.connection = null;

        return interaction.reply(
          "⏹️ Music stopped and queue cleared."
        );
      }

      /* =====================
         PAUSE
      ===================== */

      if (command === "pause") {
        const queue =
          musicQueues.get(
            interaction.guild.id
          );

        if (
          !queue ||
          !queue.playing
        ) {
          return interaction.reply(
            "❌ Abhi kuch play nahi ho raha."
          );
        }

        queue.player.pause();

        return interaction.reply(
          "⏸️ Music paused."
        );
      }

      /* =====================
         RESUME
      ===================== */

      if (command === "resume") {
        const queue =
          musicQueues.get(
            interaction.guild.id
          );

        if (!queue) {
          return interaction.reply(
            "❌ Music player active nahi hai."
          );
        }

        queue.player.unpause();

        return interaction.reply(
          "▶️ Music resumed."
        );
      }

      /* =====================
         QUEUE
      ===================== */

      if (command === "queue") {
        const queue =
          musicQueues.get(
            interaction.guild.id
          );

        if (
          !queue ||
          !queue.songs.length
        ) {
          return interaction.reply(
            "📋 Queue empty hai."
          );
        }

        const list =
          queue.songs
            .slice(0, 10)
            .map(
              (song, index) =>
                `${index + 1}. ${song.title}`
            )
            .join("\n");

        return interaction.reply(
          `🎵 **Music Queue**\n\n${list}`
        );
      }
    } catch (error) {
      console.error(
        "Interaction error:",
        error
      );

      /*
        Prevent "application did not respond"
        if something unexpected happens.
      */

      try {
        if (interaction.deferred) {
          await interaction.editReply(
            "❌ Command execute karte waqt error aa gaya."
          );
        } else if (!interaction.replied) {
          await interaction.reply({
            content:
              "❌ Command execute karte waqt error aa gaya.",
            ephemeral: true,
          });
        }
      } catch {}
    }
  }
);

/* =========================
   ANTI-NUKE EVENTS
========================= */

/* CHANNEL DELETE */

client.on("channelDelete", async channel => {
  if (!channel.guild) return;

  const executor = await getExecutor(
    channel.guild,
    AuditLogEvent.ChannelDelete,
    channel.id
  );

  if (!executor) return;

  await inspect(
    channel.guild,
    executor.id,
    "channelDelete",
    `Unauthorized channel deletion: **${channel.name}**`
  );
});

/* ROLE DELETE */

client.on("roleDelete", async role => {
  const executor = await getExecutor(
    role.guild,
    AuditLogEvent.RoleDelete,
    role.id
  );

  if (!executor) return;

  await inspect(
    role.guild,
    executor.id,
    "roleDelete",
    `Unauthorized role deletion: **${role.name}**`
  );
});

/* CHANNEL CREATE */

client.on("channelCreate", async channel => {
  if (!channel.guild) return;

  const executor = await getExecutor(
    channel.guild,
    AuditLogEvent.ChannelCreate,
    channel.id
  );

  if (!executor) return;

  await inspect(
    channel.guild,
    executor.id,
    "channelCreate",
    `Unauthorized channel creation: **${channel.name}**`
  );
});

/* ROLE CREATE */

client.on("roleCreate", async role => {
  const executor = await getExecutor(
    role.guild,
    AuditLogEvent.RoleCreate,
    role.id
  );

  if (!executor) return;

  await inspect(
    role.guild,
    executor.id,
    "roleCreate",
    `Unauthorized role creation: **${role.name}**`
  );
});

/* BAN */

client.on("guildBanAdd", async ban => {
  const executor = await getExecutor(
    ban.guild,
    AuditLogEvent.MemberBanAdd,
    ban.user.id
  );

  if (!executor) return;

  await inspect(
    ban.guild,
    executor.id,
    "ban",
    `Unauthorized ban of <@${ban.user.id}>`
  );
});

/* MEMBER REMOVE / KICK */

client.on("guildMemberRemove", async member => {
  const executor = await getExecutor(
    member.guild,
    AuditLogEvent.MemberKick,
    member.id
  );

  if (!executor) return;

  await inspect(
    member.guild,
    executor.id,
    "kick",
    `Unauthorized kick of <@${member.id}>`
  );
});

/* MEMBER UPDATE */

client.on(
  "guildMemberUpdate",
  async (oldMember, newMember) => {
    try {
      const addedRoles =
        newMember.roles.cache.filter(
          role =>
            !oldMember.roles.cache.has(
              role.id
            )
        );

      if (!addedRoles.size) return;

      const executor =
        await getExecutor(
          newMember.guild,
          AuditLogEvent.MemberRoleUpdate,
          newMember.id
        );

      if (!executor) return;

      for (const role of addedRoles.values()) {
        if (
          role.permissions.has(
            PermissionsBitField.Flags.Administrator
          ) ||
          role.permissions.has(
            PermissionsBitField.Flags.ManageGuild
          ) ||
          role.permissions.has(
            PermissionsBitField.Flags.ManageRoles
          ) ||
          role.permissions.has(
            PermissionsBitField.Flags.BanMembers
          ) ||
          role.permissions.has(
            PermissionsBitField.Flags.KickMembers
          )
        ) {
          await inspect(
            newMember.guild,
            executor.id,
            "dangerousPermission",
            `Dangerous permission role **${role.name}** added to <@${newMember.id}>`
          );

          break;
        }
      }
    } catch (error) {
      console.error(
        "Member update protection error:",
        error.message
      );
    }
  }
);

/* =========================
   LOGIN
========================= */

client.login(TOKEN);