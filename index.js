require('dotenv').config();
const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on ${PORT}`));

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    Events
} = require('discord.js');

const sqlite3 = require('sqlite3').verbose();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ],
    partials: ['CHANNEL']
});

// ================= CONFIG =================

const STAFF_ROLE_ID = "1505165878734622731";

const ROLE_IDS = {
    Silver: "1505165878696611884",
    Gold: "1505165878696611882",
    Platinum: "1505219959310258278",
    Executive: "1505165878734622730",
    Investor: "1505165878696611889",
    InvestorPlus: "1508366887745224775"
};

const LATE_FEE = 25000;
const LEASE_GRACE_MS = 72 * 60 * 60 * 1000;

// ================= DATABASE =================

const db = new sqlite3.Database('./financial.sqlite');

db.serialize(() => {

    db.run(`CREATE TABLE IF NOT EXISTS memberships (
        userId TEXT PRIMARY KEY,
        tier TEXT,
        expiresAt INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT,
        vehicle TEXT,
        remainingBalance INTEGER,
        paymentAmount INTEGER,
        frequency TEXT,
        termLength INTEGER,
        paymentsMade INTEGER DEFAULT 0,
        nextDue INTEGER,
        lateApplied INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS vehicles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT,
        vehicle TEXT,
        status TEXT
    )`);
});

// ================= UTIL =================

function getIntervalMs(freq) {
    return freq === "weekly"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
}

// ================= MEMBERSHIP =================

async function addMembership(userId, tier, days = 30) {

    const expiresAt = Date.now() + days * 86400000;

    db.run(`INSERT OR REPLACE INTO memberships VALUES (?, ?, ?)`,
        [userId, tier, expiresAt]);

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(userId);

    for (const r of Object.values(ROLE_IDS)) {
        if (member.roles.cache.has(r)) await member.roles.remove(r);
    }

    await member.roles.add(ROLE_IDS[tier]);

    member.send(`✅ You now have ${tier} until <t:${Math.floor(expiresAt/1000)}:F>`)
        .catch(() => {});
}

// ================= LEASE =================

function createLease(userId, vehicle, total, down, payment, freq, term) {

    const remaining = total - down;
    const nextDue = Date.now() + getIntervalMs(freq);

    db.run(`INSERT INTO leases 
        (userId, vehicle, remainingBalance, paymentAmount, frequency, termLength, nextDue)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, vehicle, remaining, payment, freq, term, nextDue]);

    db.run(`INSERT INTO vehicles (userId, vehicle, status)
        VALUES (?, ?, 'active')`,
        [userId, vehicle]);
}

async function applyPayment(userId) {

    db.get(`SELECT * FROM leases WHERE userId = ? AND active = 1`,
        [userId],
        async (err, lease) => {

            if (!lease) return;

            const newBalance = lease.remainingBalance - lease.paymentAmount;
            const nextDue = Date.now() + getIntervalMs(lease.frequency);
            const payments = lease.paymentsMade + 1;

            db.run(`UPDATE leases SET 
                remainingBalance = ?, 
                nextDue = ?, 
                paymentsMade = ? 
                WHERE id = ?`,
                [newBalance, nextDue, payments, lease.id]);

            if (payments >= lease.termLength || newBalance <= 0) {
                db.run(`UPDATE leases SET active = 0 WHERE id = ?`, [lease.id]);
            }
        });
}

// ================= REMINDER LOOP =================

setInterval(async () => {

    const now = Date.now();

    db.all(`SELECT * FROM leases WHERE active = 1`,
        async (err, leases) => {

            if (!leases) return;

            for (const lease of leases) {

                const user = await client.users.fetch(lease.userId).catch(() => null);
                if (!user) continue;

                const timeLeft = lease.nextDue - now;

                if (timeLeft <= 0 && lease.lateApplied === 0) {

                    db.run(`UPDATE leases SET 
                        remainingBalance = ?, 
                        lateApplied = 1 
                        WHERE id = ?`,
                        [lease.remainingBalance + LATE_FEE, lease.id]);

                    user.send(`⚠️ Late fee applied: $${LATE_FEE}`)
                        .catch(() => {});
                }

                if (timeLeft <= -LEASE_GRACE_MS) {

                    db.run(`UPDATE leases SET active = 0 WHERE id = ?`,
                        [lease.id]);

                    user.send(`🚨 Vehicle repossessed.`)
                        .catch(() => {});
                }
            }
        });

}, 60000);

// ================= SLASH COMMANDS =================

const commands = [

    new SlashCommandBuilder()
        .setName('deal')
        .setDescription('Create lease contract')
        .addUserOption(o => o.setName('user').setRequired(true))
        .addStringOption(o => o.setName('vehicle').setRequired(true))
        .addIntegerOption(o => o.setName('total').setRequired(true))
        .addIntegerOption(o => o.setName('down').setRequired(true))
        .addIntegerOption(o => o.setName('payment').setRequired(true))
        .addStringOption(o => o.setName('frequency')
            .setRequired(true)
            .addChoices(
                { name: 'Weekly', value: 'weekly' },
                { name: 'Monthly', value: 'monthly' }
            ))
        .addIntegerOption(o => o.setName('term').setRequired(true)),

    new SlashCommandBuilder()
        .setName('pay')
        .setDescription('Submit payment'),

    new SlashCommandBuilder()
        .setName('addmembership')
        .setDescription('Add membership')
        .addUserOption(o => o.setName('user').setRequired(true))
        .addStringOption(o => o.setName('tier')
            .setRequired(true)
            .addChoices(
                { name: 'Silver', value: 'Silver' },
                { name: 'Gold', value: 'Gold' },
                { name: 'Platinum', value: 'Platinum' },
                { name: 'Executive', value: 'Executive' },
                { name: 'Investor', value: 'Investor' },
                { name: 'Investor+', value: 'InvestorPlus' }
            ))

].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
    );
    console.log("✅ Commands registered");
})();

// ================= INTERACTIONS =================

client.on(Events.InteractionCreate, async interaction => {

    if (interaction.isChatInputCommand()) {

        if (interaction.commandName === "deal") {

            const u = interaction.options.getUser("user");

            const btn = new ButtonBuilder()
                .setCustomId(`accept_${u.id}_${interaction.options.getString("vehicle")}_${interaction.options.getInteger("total")}_${interaction.options.getInteger("down")}_${interaction.options.getInteger("payment")}_${interaction.options.getString("frequency")}_${interaction.options.getInteger("term")}`)
                .setLabel("Accept Contract")
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder().addComponents(btn);

            return interaction.reply({
                content: `📄 **Lease Contract**\nBuyer: <@${u.id}>`,
                components: [row]
            });
        }

        if (interaction.commandName === "pay") {
            await applyPayment(interaction.user.id);
            return interaction.reply("✅ Payment applied.");
        }

        if (interaction.commandName === "addmembership") {

            if (!interaction.member.roles.cache.has(STAFF_ROLE_ID))
                return interaction.reply({ content: "Staff only.", ephemeral: true });

            const user = interaction.options.getUser("user");
            const tier = interaction.options.getString("tier");

            await addMembership(user.id, tier);

            return interaction.reply("✅ Membership added.");
        }
    }

    if (interaction.isButton()) {

        const id = interaction.customId;

        if (id.startsWith("accept_")) {

            const parts = id.split("_");

            const userId = parts[1];
            const vehicle = parts[2];
            const total = parseInt(parts[3]);
            const down = parseInt(parts[4]);
            const payment = parseInt(parts[5]);
            const freq = parts[6];
            const term = parseInt(parts[7]);

            if (interaction.user.id !== userId) {
                return interaction.reply({
                    content: "❌ Only the buyer can accept this contract.",
                    ephemeral: true
                });
            }

            db.get(`SELECT * FROM leases WHERE userId = ? AND vehicle = ? AND active = 1`,
                [userId, vehicle],
                async (err, existing) => {

                    if (existing) {
                        return interaction.reply({
                            content: "❌ Contract already accepted.",
                            ephemeral: true
                        });
                    }

                    createLease(userId, vehicle, total, down, payment, freq, term);

                    const disabled = ButtonBuilder.from(interaction.message.components[0].components[0])
                        .setDisabled(true);

                    const row = new ActionRowBuilder().addComponents(disabled);

                    await interaction.update({
                        content: interaction.message.content + "\n\n✅ Contract Accepted.",
                        components: [row]
                    });
                });
        }
    }
});

client.login(process.env.TOKEN);
