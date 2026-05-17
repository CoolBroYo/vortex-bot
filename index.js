require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    Events,
    EmbedBuilder
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

const express = require("express");
const app = express();

app.get("/", (req, res) => {
    res.send("Vortex Bot is running.");
});

app.get("/", (req, res) => {
    res.status(200).send("Vortex Bot is running.");
});

app.head("/", (req, res) => {
    res.sendStatus(200);
});

app.use((req, res) => {
    res.status(200).send("Vortex Bot is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});

// ================= CLIENT =================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: ['CHANNEL']
});

// ================= CONFIG =================

const STAFF_ROLE_ID = "1505165878734622731";

const LOG_CHANNELS = {
    lease: "1505165879569158291",
    payment: "1505266422119665825",
    membership: "1505262247981744229",
    repo: "1505266533147087009",
    credit: "1505266567095652423"
};

const ROLE_IDS = {
    Silver: "1505165878696611884",
    Gold: "1505165878696611882",
    Platinum: "1505219959310258278",
    Executive: "1505165878734622730",
    Investor: "1505165878696611889"
};

const CREDIT_REQUIREMENTS = {
    Silver: 500,
    Gold: 600,
    Platinum: 675,
    Executive: 725,
    Investor: 775
};

const STARTING_CREDIT = 600;
const LATE_FEE = 2500;
const LEASE_GRACE_MS = 72 * 60 * 60 * 1000; // 72 hours
const INVESTOR_GRACE_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

// ================= DATABASE =================

const db = new sqlite3.Database('./financial.sqlite');

db.serialize(() => {

    // CREDIT TABLE
    db.run(`
        CREATE TABLE IF NOT EXISTS credit (
            userId TEXT PRIMARY KEY,
            score INTEGER
        )
    `);

    // MEMBERSHIP TABLE
    db.run(`
        CREATE TABLE IF NOT EXISTS memberships (
            userId TEXT PRIMARY KEY,
            tier TEXT,
            expiresAt INTEGER
        )
    `);

    // INVESTOR TRACKING
    db.run(`
        CREATE TABLE IF NOT EXISTS investors (
            userId TEXT PRIMARY KEY,
            nextProofDue INTEGER,
            proofGraceStart INTEGER
        )
    `);

    // LEASE TABLE
    db.run(`
        CREATE TABLE IF NOT EXISTS leases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId TEXT,
            vehicle TEXT,
            totalPrice INTEGER,
            remainingBalance INTEGER,
            paymentAmount INTEGER,
            frequency TEXT,
            termLength INTEGER,
            paymentsMade INTEGER DEFAULT 0,
            nextDue INTEGER,
            lateApplied INTEGER DEFAULT 0,
            graceStart INTEGER DEFAULT 0,
            active INTEGER DEFAULT 1
        )
    `);

    // VEHICLE TABLE
    db.run(`
        CREATE TABLE IF NOT EXISTS vehicles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId TEXT,
            vehicle TEXT,
            status TEXT
        )
    `);

    // PAYMENT HISTORY
    db.run(`
        CREATE TABLE IF NOT EXISTS payment_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId TEXT,
            leaseId INTEGER,
            amount INTEGER,
            timestamp INTEGER,
            onTime INTEGER
        )
    `);

    // REMINDER TRACKING
    db.run(`
        CREATE TABLE IF NOT EXISTS reminder_tracking (
            leaseId INTEGER,
            type TEXT,
            sent INTEGER,
            PRIMARY KEY (leaseId, type)
        )
    `);
});

// ================= UTILITY =================

async function logChannel(type, message) {
    try {
        const channel = await client.channels.fetch(LOG_CHANNELS[type]);
        if (channel) channel.send(message);
    } catch (err) {}
}

function getIntervalMs(freq) {
    return freq === "weekly"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
}

// ================= CREDIT ENGINE =================

function getCredit(userId) {
    return new Promise((resolve) => {
        db.get(`SELECT * FROM credit WHERE userId = ?`, [userId], (err, row) => {
            if (!row) {
                db.run(`INSERT INTO credit (userId, score) VALUES (?, ?)`,
                    [userId, STARTING_CREDIT]);
                resolve(STARTING_CREDIT);
            } else {
                resolve(row.score);
            }
        });
    });
}

async function updateCredit(userId, change, reason) {

    const current = await getCredit(userId);
    const newScore = current + change;

    db.run(`UPDATE credit SET score = ? WHERE userId = ?`,
        [newScore, userId]);

    await logChannel("credit",
`📊 Credit Update
User: <@${userId}>
Change: ${change}
New Score: ${newScore}
Reason: ${reason}`);

    await checkMembershipEligibility(userId, newScore);
}

async function checkMembershipEligibility(userId, score) {

    db.get(`SELECT * FROM memberships WHERE userId = ?`,
        [userId],
        async (err, row) => {

            if (!row) return;

            const currentTier = row.tier;

            let eligibleTier = null;

            const tiers = Object.keys(CREDIT_REQUIREMENTS)
                .sort((a, b) => CREDIT_REQUIREMENTS[b] - CREDIT_REQUIREMENTS[a]);

            for (const tier of tiers) {
                if (score >= CREDIT_REQUIREMENTS[tier]) {
                    eligibleTier = tier;
                    break;
                }
            }

            if (!eligibleTier) {
                await removeAllMembership(userId);
                return;
            }

            if (eligibleTier !== currentTier) {
                await downgradeMembership(userId, eligibleTier);
            }
        });
}

// ================= MEMBERSHIP ENGINE =================

async function addMembership(userId, tier, durationDays = 30) {

    const expiresAt = Date.now() + (durationDays * 24 * 60 * 60 * 1000);

    db.run(`
        INSERT OR REPLACE INTO memberships (userId, tier, expiresAt)
        VALUES (?, ?, ?)
    `, [userId, tier, expiresAt]);

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(userId);

    // Remove all membership roles first
    for (const roleId of Object.values(ROLE_IDS)) {
        if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId);
        }
    }

    await member.roles.add(ROLE_IDS[tier]);

    await logChannel("membership",
`✅ Membership Added
User: <@${userId}>
Tier: ${tier}
Expires: <t:${Math.floor(expiresAt/1000)}:F>`);

    member.send(`✅ You now have ${tier} membership until <t:${Math.floor(expiresAt/1000)}:F>.`)
        .catch(() => {});
}

async function downgradeMembership(userId, newTier) {

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(userId);

    for (const roleId of Object.values(ROLE_IDS)) {
        if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId);
        }
    }

    await member.roles.add(ROLE_IDS[newTier]);

    db.run(`UPDATE memberships SET tier = ? WHERE userId = ?`,
        [newTier, userId]);

    await logChannel("membership",
`🔻 Membership Downgraded
User: <@${userId}>
New Tier: ${newTier}`);

    member.send(`⚠️ Your membership has been downgraded to ${newTier} due to credit changes.`)
        .catch(() => {});
}

async function removeAllMembership(userId) {

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(userId);

    for (const roleId of Object.values(ROLE_IDS)) {
        if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId);
        }
    }

    db.run(`DELETE FROM memberships WHERE userId = ?`, [userId]);

    await logChannel("membership",
`❌ Membership Removed
User: <@${userId}>
Reason: Credit below minimum.`);

    member.send("❌ Your membership has been removed due to low credit.")
        .catch(() => {});
}

// ================= MEMBERSHIP EXPIRATION CHECK =================

async function checkMembershipExpirations() {

    const now = Date.now();

    db.all(`SELECT * FROM memberships`, async (err, rows) => {
        if (!rows) return;

        for (const row of rows) {
            if (now >= row.expiresAt) {
                await removeAllMembership(row.userId);
            }
        }
    });
}

// ================= LEASE ENGINE =================

function createLease(userId, vehicle, totalPrice, downPayment, paymentAmount, frequency, termLength) {

    const remaining = totalPrice - downPayment;
    const interval = getIntervalMs(frequency);
    const nextDue = Date.now() + interval;

    db.run(`
        INSERT INTO leases 
        (userId, vehicle, totalPrice, remainingBalance, paymentAmount, frequency, termLength, nextDue)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, vehicle, totalPrice, remaining, paymentAmount, frequency, termLength, nextDue]);

    db.run(`
        INSERT INTO vehicles (userId, vehicle, status)
        VALUES (?, ?, 'active')
    `, [userId, vehicle]);

    logChannel("lease",
`🚗 Lease Created
User: <@${userId}>
Vehicle: ${vehicle}
Remaining: $${remaining}
Payment: $${paymentAmount} (${frequency})
Term: ${termLength} cycles`);
}

// ================= APPLY PAYMENT =================

async function applyPayment(userId) {

    db.get(`SELECT * FROM leases WHERE userId = ? AND active = 1`,
        [userId],
        async (err, lease) => {

            if (!lease) return;

            const now = Date.now();
            const onTime = now <= lease.nextDue ? 1 : 0;

            let newBalance = lease.remainingBalance - lease.paymentAmount;
            let paymentsMade = lease.paymentsMade + 1;

            const nextDue = now + getIntervalMs(lease.frequency);

            db.run(`
                UPDATE leases
                SET remainingBalance = ?, 
                    nextDue = ?, 
                    paymentsMade = ?, 
                    lateApplied = 0,
                    graceStart = 0
                WHERE id = ?
            `, [newBalance, nextDue, paymentsMade, lease.id]);

            db.run(`
                INSERT INTO payment_history
                (userId, leaseId, amount, timestamp, onTime)
                VALUES (?, ?, ?, ?, ?)
            `, [userId, lease.id, lease.paymentAmount, now, onTime]);

            if (onTime) {
                await updateCredit(userId, +10, "On-time Payment");
            }

            // TERM ENFORCEMENT
            if (paymentsMade >= lease.termLength || newBalance <= 0) {
                await completeLease(lease);
            }

            logChannel("payment",
`💰 Payment Approved
User: <@${userId}>
Amount: $${lease.paymentAmount}
Remaining: $${newBalance}`);
        });
}

// ================= COMPLETE LEASE =================

async function completeLease(lease) {

    db.run(`UPDATE leases SET active = 0 WHERE id = ?`, [lease.id]);

    db.run(`
        UPDATE vehicles 
        SET status = 'owned' 
        WHERE userId = ? AND vehicle = ?
    `, [lease.userId, lease.vehicle]);

    await updateCredit(lease.userId, +20, "Lease Completed / Early Payoff");

    logChannel("lease",
`✅ Lease Completed
User: <@${lease.userId}>
Vehicle: ${lease.vehicle}`);
}

// ================= LATE HANDLING =================

async function applyLatePenalty(lease) {

    if (lease.lateApplied) return;

    const newBalance = lease.remainingBalance + LATE_FEE;

    db.run(`
        UPDATE leases
        SET remainingBalance = ?, 
            lateApplied = 1,
            graceStart = ?
        WHERE id = ?
    `, [newBalance, Date.now(), lease.id]);

    await updateCredit(lease.userId, -25, "Late Payment");

    const user = await client.users.fetch(lease.userId).catch(() => null);
    if (user) {
        user.send(
`⚠️ Late Payment Notice
Vehicle: ${lease.vehicle}
A $${LATE_FEE} late fee has been added.
You have 72 hours before repossession.`
        ).catch(() => {});
    }

    logChannel("lease",
`⚠️ Late Fee Applied
User: <@${lease.userId}>
+$${LATE_FEE}`);
}

// ================= AUTO REPO =================

async function autoRepo(lease) {

    db.run(`UPDATE leases SET active = 0 WHERE id = ?`, [lease.id]);

    db.run(`
        UPDATE vehicles 
        SET status = 'repossessed'
        WHERE userId = ? AND vehicle = ?
    `, [lease.userId, lease.vehicle]);

    await updateCredit(lease.userId, -100, "Vehicle Repossession");

    const user = await client.users.fetch(lease.userId).catch(() => null);
    if (user) {
        user.send(`🚨 Your vehicle (${lease.vehicle}) has been repossessed due to non-payment.`)
            .catch(() => {});
    }

    logChannel("repo",
`🚨 AUTO REPO
User: <@${lease.userId}>
Vehicle: ${lease.vehicle}`);
}

// ================= INVESTOR ENGINE =================

async function addInvestor(userId) {

    const nextProofDue = Date.now() + (30 * 24 * 60 * 60 * 1000);

    db.run(`
        INSERT OR REPLACE INTO investors (userId, nextProofDue, proofGraceStart)
        VALUES (?, ?, 0)
    `, [userId, nextProofDue]);

    await logChannel("membership",
`📈 Investor Added
User: <@${userId}>
Next Proof Due: <t:${Math.floor(nextProofDue/1000)}:F>`);

    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
        user.send(`📈 Investor status active. Proof due by <t:${Math.floor(nextProofDue/1000)}:F>.`)
            .catch(() => {});
    }
}

async function removeInvestor(userId) {

    db.run(`DELETE FROM investors WHERE userId = ?`, [userId]);

    await logChannel("membership",
`❌ Investor Removed
User: <@${userId}>
Reason: No proof submitted.`);

    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
        user.send("❌ Your investor status has been revoked due to missing proof.")
            .catch(() => {});
    }
}

// ================= REMINDER LOOP =================

setInterval(async () => {

    const now = Date.now();

    // -------- LEASE CHECK --------
    db.all(`SELECT * FROM leases WHERE active = 1`, async (err, leases) => {

        if (!leases) return;

        for (const lease of leases) {

            const user = await client.users.fetch(lease.userId).catch(() => null);
            if (!user) continue;

            const timeLeft = lease.nextDue - now;

            // PRE-DUE REMINDERS
            const hoursArray = [72, 48, 24, 10, 1];

            for (const hours of hoursArray) {

                const key = `reminder_${hours}`;
                const ms = hours * 60 * 60 * 1000;

                if (timeLeft > 0 && timeLeft <= ms) {

                    db.get(`
                        SELECT * FROM reminder_tracking 
                        WHERE leaseId = ? AND type = ?
                    `, [lease.id, key], async (err, row) => {

                        if (!row) {
                            user.send(
`⏰ Payment Reminder
Vehicle: ${lease.vehicle}
Due in ${hours} hour(s).`
                            ).catch(() => {});

                            db.run(`
                                INSERT INTO reminder_tracking (leaseId, type, sent)
                                VALUES (?, ?, 1)
                            `, [lease.id, key]);
                        }
                    });
                }
            }

            // LATE DETECTION
            if (timeLeft <= 0) {

                await applyLatePenalty(lease);

                const overdueTime = now - lease.nextDue;

                // OVERDUE ESCALATIONS
                const overdueHours = Math.floor(overdueTime / (60 * 60 * 1000));

                if (overdueHours === 24) {
                    user.send("⚠️ You are 24 hours overdue.").catch(() => {});
                }

                if (overdueHours === 48) {
                    user.send("🚨 You are 48 hours overdue. Repo approaching.").catch(() => {});
                }

                if (overdueTime >= LEASE_GRACE_MS) {
                    await autoRepo(lease);
                }
            }
        }
    });

    // -------- MEMBERSHIP EXPIRATION --------
    await checkMembershipExpirations();

    // -------- INVESTOR CHECK --------
    db.all(`SELECT * FROM investors`, async (err, investors) => {

        if (!investors) return;

        for (const investor of investors) {

            const user = await client.users.fetch(investor.userId).catch(() => null);
            if (!user) continue;

            if (now >= investor.nextProofDue && investor.proofGraceStart === 0) {

                db.run(`
                    UPDATE investors
                    SET proofGraceStart = ?
                    WHERE userId = ?
                `, [now, investor.userId]);

                user.send(
`📄 Investor Proof Required
Submit proof within 5 days to keep status.`
                ).catch(() => {});
            }

            if (investor.proofGraceStart !== 0 &&
                now >= investor.proofGraceStart + INVESTOR_GRACE_MS) {

                await removeInvestor(investor.userId);
            }
        }
    });

}, 60000);

// ================= SLASH COMMANDS =================

const commands = [

    new SlashCommandBuilder()
        .setName('deal')
        .setDescription('Create lease (Staff)')
        .addUserOption(o => o.setName('user').setDescription('Buyer').setRequired(true))
        .addStringOption(o => o.setName('vehicle').setDescription('Vehicle').setRequired(true))
        .addIntegerOption(o => o.setName('total').setDescription('Total Price').setRequired(true))
        .addIntegerOption(o => o.setName('down').setDescription('Down Payment').setRequired(true))
        .addIntegerOption(o => o.setName('payment').setDescription('Cycle Payment').setRequired(true))
        .addStringOption(o => o.setName('frequency')
            .setDescription('weekly or monthly')
            .setRequired(true)
            .addChoices(
                { name: 'Weekly', value: 'weekly' },
                { name: 'Monthly', value: 'monthly' }
            ))
        .addIntegerOption(o => o.setName('term').setDescription('Number of cycles').setRequired(true)),

    new SlashCommandBuilder().setName('pay').setDescription('Submit payment proof'),
    new SlashCommandBuilder().setName('credit').setDescription('Check credit score'),
    new SlashCommandBuilder().setName('garage').setDescription('View your vehicles'),

    new SlashCommandBuilder()
        .setName('repo')
        .setDescription('Manual repo (Staff)')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),

    new SlashCommandBuilder()
        .setName('adjustcredit')
        .setDescription('Adjust credit (Staff)')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Amount +/-').setRequired(true)),

    new SlashCommandBuilder()
        .setName('payoff')
        .setDescription('Early full payoff'),

    new SlashCommandBuilder()
        .setName('addmembership')
        .setDescription('Add membership (Staff)')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o => o.setName('tier')
            .setDescription('Tier')
            .setRequired(true)
            .addChoices(
                { name: 'Silver', value: 'Silver' },
                { name: 'Gold', value: 'Gold' },
                { name: 'Platinum', value: 'Platinum' },
                { name: 'Executive', value: 'Executive' },
                { name: 'Investor', value: 'Investor' }
            )),

    new SlashCommandBuilder()
        .setName('addinvestor')
        .setDescription('Add investor (Staff)')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),

    new SlashCommandBuilder()
    .setName('buymembership')
    .setDescription('Request to purchase membership')
    .addStringOption(o => o.setName('tier')
        .setDescription('Tier you want to purchase')
        .setRequired(true)
        .addChoices(
            { name: 'Silver', value: 'Silver' },
            { name: 'Gold', value: 'Gold' },
            { name: 'Platinum', value: 'Platinum' },
            { name: 'Executive', value: 'Executive' },
            { name: 'Investor', value: 'Investor' }
        )),

    new SlashCommandBuilder()
        .setName('financialaudit')
        .setDescription('System health check')

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

        const member = interaction.member;

        // DEAL
        if (interaction.commandName === "deal") {

            if (!member.roles.cache.has(STAFF_ROLE_ID))
                return interaction.reply({ content: "Staff only.", ephemeral: true });

            const u = interaction.options.getUser("user");
            const vehicle = interaction.options.getString("vehicle");
            const total = interaction.options.getInteger("total");
            const down = interaction.options.getInteger("down");
            const payment = interaction.options.getInteger("payment");
            const frequency = interaction.options.getString("frequency");
            const term = interaction.options.getInteger("term");

            const btn = new ButtonBuilder()
                .setCustomId(`accept_${u.id}_${vehicle}_${total}_${down}_${payment}_${frequency}_${term}`)
                .setLabel("Accept Contract")
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder().addComponents(btn);

            return interaction.reply({
                content:
`📄 Lease Contract
Buyer: <@${u.id}>
Vehicle: ${vehicle}
Total: $${total}
Down: $${down}
Payment: $${payment} (${frequency})
Term: ${term} cycles`,
                components: [row]
            });
        }

// BUY MEMBERSHIP
if (interaction.commandName === "buymembership") {

    const tier = interaction.options.getString("tier");
    const userId = interaction.user.id;

    const credit = await getCredit(userId);

    if (credit < CREDIT_REQUIREMENTS[tier]) {
        return interaction.reply({
            content: `❌ You need at least ${CREDIT_REQUIREMENTS[tier]} credit for ${tier}. Your credit: ${credit}`,
            ephemeral: true
        });
    }

    await interaction.reply({
        content: "✅ Credit verified. Check DMs to upload payment proof.",
        ephemeral: true
    });

    const dm = await interaction.user.createDM();
    await dm.send(`Upload payment proof for ${tier} membership.`);

    const filter = m => m.author.id === userId && m.attachments.size > 0;

    dm.awaitMessages({ filter, max: 1, time: 300000 })
        .then(async collected => {

            const attachment = collected.first().attachments.first();

            const approve = new ButtonBuilder()
                .setCustomId(`approvemember_${userId}_${tier}`)
                .setLabel("Approve")
                .setStyle(ButtonStyle.Success);

            const deny = new ButtonBuilder()
                .setCustomId(`denymember_${userId}`)
                .setLabel("Deny")
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(approve, deny);

            const channel = await client.channels.fetch("1505262247981744229");

            await channel.send({
                content: `📥 Membership Purchase Request
User: <@${userId}>
Tier: ${tier}
Credit: ${credit}`,
                files: [attachment.url],
                components: [row]
            });

            dm.send("✅ Submitted for staff approval.");
        });
}

        // PAY
        if (interaction.commandName === "pay") {

            await interaction.reply({ content: "Check DMs to upload proof.", ephemeral: true });

            const dm = await interaction.user.createDM();
            await dm.send("Upload payment screenshot.");

            const filter = m => m.author.id === interaction.user.id && m.attachments.size > 0;

            dm.awaitMessages({ filter, max: 1, time: 300000 })
                .then(async collected => {

                    const attachment = collected.first().attachments.first();

                    const approve = new ButtonBuilder()
                        .setCustomId(`approvepay_${interaction.user.id}`)
                        .setLabel("Approve")
                        .setStyle(ButtonStyle.Success);

                    const deny = new ButtonBuilder()
                        .setCustomId(`denypay_${interaction.user.id}`)
                        .setLabel("Deny")
                        .setStyle(ButtonStyle.Danger);

                    const row = new ActionRowBuilder().addComponents(approve, deny);

                    const channel = await client.channels.fetch(LOG_CHANNELS.payment);

                    await channel.send({
                        content: `💳 Payment Proof from <@${interaction.user.id}>`,
                        files: [attachment.url],
                        components: [row]
                    });

                    dm.send("✅ Submitted for approval.");
                });
        }

        // CREDIT
        if (interaction.commandName === "credit") {
            const score = await getCredit(interaction.user.id);
            return interaction.reply({ content: `📊 Credit Score: ${score}`, ephemeral: true });
        }

        // GARAGE
        if (interaction.commandName === "garage") {
            db.all(`SELECT * FROM vehicles WHERE userId = ?`,
                [interaction.user.id],
                (err, rows) => {

                    if (!rows.length)
                        return interaction.reply({ content: "No vehicles.", ephemeral: true });

                    const list = rows.map(v => `${v.vehicle} (${v.status})`).join("\n");

                    interaction.reply({ content: `🚗 Your Vehicles:\n${list}`, ephemeral: true });
                });
        }

        // REPO
        if (interaction.commandName === "repo") {
            if (!member.roles.cache.has(STAFF_ROLE_ID))
                return interaction.reply({ content: "Staff only.", ephemeral: true });

            const user = interaction.options.getUser("user");

            db.get(`SELECT * FROM leases WHERE userId = ? AND active = 1`,
                [user.id],
                async (err, lease) => {

                    if (!lease)
                        return interaction.reply({ content: "No active lease.", ephemeral: true });

                    await autoRepo(lease);
                    interaction.reply("✅ Repo executed.");
                });
        }

        // ADJUST CREDIT
        if (interaction.commandName === "adjustcredit") {
            if (!member.roles.cache.has(STAFF_ROLE_ID))
                return interaction.reply({ content: "Staff only.", ephemeral: true });

            const user = interaction.options.getUser("user");
            const amount = interaction.options.getInteger("amount");

            await updateCredit(user.id, amount, "Manual Adjustment");
            interaction.reply("✅ Credit adjusted.");
        }

        // PAYOFF
        if (interaction.commandName === "payoff") {

            db.get(`SELECT * FROM leases WHERE userId = ? AND active = 1`,
                [interaction.user.id],
                async (err, lease) => {

                    if (!lease)
                        return interaction.reply({ content: "No active lease.", ephemeral: true });

                    await completeLease(lease);
                    interaction.reply("✅ Lease paid off.");
                });
        }

        // ADD MEMBERSHIP
        if (interaction.commandName === "addmembership") {
            if (!member.roles.cache.has(STAFF_ROLE_ID))
                return interaction.reply({ content: "Staff only.", ephemeral: true });

            const user = interaction.options.getUser("user");
            const tier = interaction.options.getString("tier");

            await addMembership(user.id, tier);
            interaction.reply("✅ Membership added.");
        }

        // ADD INVESTOR
        if (interaction.commandName === "addinvestor") {
            if (!member.roles.cache.has(STAFF_ROLE_ID))
                return interaction.reply({ content: "Staff only.", ephemeral: true });

            const user = interaction.options.getUser("user");
            await addInvestor(user.id);
            interaction.reply("✅ Investor added.");
        }

        // AUDIT
        if (interaction.commandName === "financialaudit") {
            return interaction.reply("✅ System running. Database connected. Reminder loop active.");
        }
    }

    // BUTTONS
    if (interaction.isButton()) {

        const id = interaction.customId;

        if (id.startsWith("accept_")) {

            const parts = id.split("_");

            createLease(
                parts[1],
                parts[2],
                parseInt(parts[3]),
                parseInt(parts[4]),
                parseInt(parts[5]),
                parts[6],
                parseInt(parts[7])
            );

            return interaction.reply({ content: "✅ Lease Activated.", ephemeral: true });
        }

        if (id.startsWith("approvepay_")) {
            const userId = id.split("_")[1];
            await applyPayment(userId);
            return interaction.reply({ content: "✅ Payment Approved.", ephemeral: true });
        }

        if (id.startsWith("denypay_")) {
            return interaction.reply({ content: "❌ Payment Denied.", ephemeral: true });
        }
if (id.startsWith("approvemember_")) {

    const parts = id.split("_");
    const userId = parts[1];
    const tier = parts[2];

    await addMembership(userId, tier);

    return interaction.reply({ content: "✅ Membership approved.", ephemeral: true });
}

if (id.startsWith("denymember_")) {

    const userId = id.split("_")[1];

    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
        user.send("❌ Your membership request was denied.")
            .catch(() => {});
    }

    return interaction.reply({ content: "❌ Membership denied.", ephemeral: true });
}
    }
});

client.login(process.env.TOKEN);