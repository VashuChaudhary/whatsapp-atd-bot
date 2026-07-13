// const dns = require("dns");
// dns.setServers(["8.8.8.8", "8.8.4.4"]);
// dns.setDefaultResultOrder("ipv4first");

require("dotenv").config();

const { Client, LocalAuth, RemoteAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const express = require("express");
const QRCode = require("qrcode");
const mongoose = require("mongoose");
const { MongoStore } = require("wwebjs-mongo");

const app = express();
const PORT = process.env.PORT || 3000;
const GAS_URL = process.env.GAS_URL;
const GROUP_NAME = process.env.GROUP_NAME;
const MONGODB_URI = process.env.MONGODB_URI;

let latestQr = null;
let botState = "INITIALIZING";
let client = null;

console.log("🔄 Starting bot application, please wait...");

// Verify essential environment configurations
if (process.env.RENDER && !GAS_URL) {
	console.error(
		"❌ Missing GAS_URL environment variable. Please set it in your Render service.",
	);
	process.exit(1);
}

// ==========================================
// EXPRESS SERVER (Satisfies Render & Serves QR)
// ==========================================

app.get("/", (req, res) => {
	res.send(`
		<html>
			<head>
				<title>Bot Status Dashboard</title>
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>
					body { font-family: -apple-system, sans-serif; text-align: center; padding: 2rem; background: #f0f2f5; color: #111b21; }
					.card { max-width: 500px; margin: 2rem auto; background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
					.status { font-weight: bold; padding: 0.25rem 0.75rem; border-radius: 50px; }
					.connected { background: #d9fdd3; color: #128c7e; }
					.waiting { background: #fff3cd; color: #856404; }
					.loading { background: #e2e3e5; color: #383d41; }
					.btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem; background: #00a884; color: white; text-decoration: none; border-radius: 20px; font-weight: bold; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
					.btn:hover { background: #008f72; }
				</style>
			</head>
			<body>
				<div class="card">
					<h2>🤖 WhatsApp Attendance Bot</h2>
					<p style="margin: 1.5rem 0;">
						Status: 
						<span class="status ${botState === "CONNECTED" ? "connected" : botState === "LOADING" ? "loading" : "waiting"}">
							${botState}
						</span>
					</p>
					${botState !== "CONNECTED" ? '<a href="/qr" class="btn">View & Scan QR Code</a>' : '<p style="color: #667781;">The bot is fully connected, authorized, and actively monitoring group updates!</p>'}
				</div>
			</body>
		</html>
	`);
});

app.get("/qr", async (req, res) => {
	if (botState === "CONNECTED") {
		return res.redirect("/");
	}
	if (!latestQr) {
		return res.send(`
			<html>
				<head>
					<meta http-equiv="refresh" content="3">
					<meta name="viewport" content="width=device-width, initial-scale=1.0">
					<style>body { font-family: sans-serif; text-align: center; padding: 3rem; background: #f0f2f5; }</style>
				</head>
				<body>
					<h2>⏳ Waiting for QR code generation...</h2>
					<p>Connecting to WhatsApp Web stream. This page will reload automatically in a moment.</p>
					<script>setTimeout(() => { location.reload(); }, 3000);</script>
				</body>
			</html>
		`);
	}
	try {
		const qrDataUrl = await QRCode.toDataURL(latestQr);
		res.send(`
			<html>
				<head>
					<title>Scan WhatsApp QR</title>
					<meta name="viewport" content="width=device-width, initial-scale=1.0">
					<meta http-equiv="refresh" content="20">
					<style>
						body { font-family: -apple-system, sans-serif; text-align: center; padding: 1.5rem; background-color: #f0f2f5; margin: 0; }
						.container { max-width: 400px; margin: 2rem auto; background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
						h2 { color: #075e54; margin-top: 0; }
						p { color: #667781; font-size: 0.95rem; line-height: 1.4; }
						img { width: 100%; max-width: 260px; margin: 1.5rem auto; display: block; border: 1px solid #e9edef; padding: 10px; background: white; border-radius: 8px; }
						.footer { font-size: 0.8rem; color: #8696a0; margin-top: 1.5rem; }
						.back-link { display: block; margin-top: 1.5rem; color: #00a884; text-decoration: none; font-weight: bold; }
					</style>
				</head>
				<body>
					<div class="container">
						<h2>📱 Link Device</h2>
						<p>Open WhatsApp on your phone, navigate to Linked Devices, and scan the QR code below:</p>
						<img src="${qrDataUrl}" alt="WhatsApp QR Code" />
						<div class="footer">Page auto-refreshes every 20 seconds. Generated: ${new Date().toLocaleTimeString()}</div>
						<a href="/" class="back-link">← Back to Status</a>
					</div>
				</body>
			</html>
		`);
	} catch (err) {
		res.status(500).send("Failed to render QR code visual: " + err.message);
	}
});

// Bind immediately to satisfy Render's port listener healthcheck
app.listen(PORT, () => {
	console.log(`🌐 Web interface active and listening on port ${PORT}`);
});

// ==========================================
// UTILITY FUNCTIONS & INITIALIZATION
// ==========================================

const findChromium = () => {
	const candidates = [
		process.env.CHROMIUM_PATH,
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome-stable",
	].filter(Boolean);

	const fs = require("fs");
	for (const p of candidates) {
		try {
			if (fs.existsSync(p)) return p;
		} catch (e) {
			// ignore
		}
	}
	return null;
};

const setupAndStartBot = async () => {
	const chromiumPath = findChromium();

	// Aggressively optimized for low-memory (512MB RAM) environments like Render
	const puppeteerOpts = {
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
			"--disable-gpu",
		],
	};
	if (chromiumPath) puppeteerOpts.executablePath = chromiumPath;

	let authStrategy;

	// Determine authentication strategy based on platform capabilities
	if (MONGODB_URI) {
		console.log(
			"🗄️ MongoDB URI detected! Attempting to set up database-backed RemoteAuth...",
		);
		try {
			//adding for db error only
			// const dns = require("dns");

			// dns.setDefaultResultOrder("ipv4first");

			await mongoose.connect(MONGODB_URI);
			console.log("✅ Successfully connected to MongoDB Atlas!");

			const store = new MongoStore({ mongoose: mongoose });
			authStrategy = new RemoteAuth({
				store: store,
				backupSyncIntervalMs: 300000, // Perform database session sync every 5 minutes
				clientId: "whatsapp-atd-bot",
				dataPath: "./.wwebjs_auth",
			});
			console.log(
				"🔐 RemoteAuth configured. WhatsApp session data will back up to MongoDB.",
			);
		} catch (mongoErr) {
			console.error(
				"❌ MongoDB connection failed! Defaulting to LocalAuth filesystem fallback...",
				mongoErr.message,
			);
			authStrategy = new LocalAuth({
				dataPath: "./.wwebjs_auth",
			});
		}
	} else {
		console.log(
			"📁 No MONGODB_URI found. Utilizing LocalAuth on native filesystem storage.",
		);
		authStrategy = new LocalAuth({
			dataPath: "./.wwebjs_auth",
		});
	}

	client = new Client({
		authStrategy: authStrategy,
		puppeteer: puppeteerOpts,
	});

	// ==========================================
	// BOT LISTENERS
	// ==========================================

	client.on("qr", (qr) => {
		latestQr = qr;
		botState = "AWAITING_SCAN";
		console.log(
			"📱 New QR code generated. Access your Render web URL to scan.",
		);
		qrcode.generate(qr, { small: true });
	});

	client.on("loading_screen", (percent, message) => {
		botState = "LOADING";
		console.log(`⏳ Synchronizing chats: ${percent}% - ${message}`);
	});

	client.on("authenticated", () => {
		botState = "AUTHENTICATED";
		latestQr = null;
		console.log(
			"🔐 Authenticated successfully! Generating session parameters...",
		);
	});

	client.on("remote_session_saved", () => {
		console.log(
			"💾 SUCCESS: Session backup successfully saved and synced to MongoDB!",
		);
	});

	client.on("auth_failure", (msg) => {
		botState = "AUTH_FAILED";
		console.error("❌ Authentication error:", msg);
	});

	client.on("ready", async () => {
		botState = "CONNECTED";
		latestQr = null;
		console.log("✅ WhatsApp Client is fully operational and authenticated!");

		try {
			const chats = await client.getChats();
			const group = chats.find((c) => c.name === GROUP_NAME);

			if (group) {
				console.log(
					`\n📋 Found target attendance group "${GROUP_NAME}". Registered members:`,
				);
				for (const participant of group.participants) {
					const contact = await client.getContactById(
						participant.id._serialized,
					);
					console.log(
						` - ${contact.pushname || "Unknown"} → ${contact.number}`,
					);
				}
			} else {
				console.log(
					`⚠️ Group "${GROUP_NAME}" was not found in your active chats list.`,
				);
			}
		} catch (chatErr) {
			console.error("⚠️ Failed to parse active chats list:", chatErr.message);
		}
	});

	client.on("disconnected", (reason) => {
		botState = "DISCONNECTED";
		console.log("🔌 WhatsApp connection disconnected:", reason);
	});

	// Changed to message_create to capture all events consistently in Render
	//og
	// client.on("message", async (msg) => {
	// 	console.log("📨 Message received on platform, from:", msg.from);

	// 	// Filter out non-group chats
	// 	if (!msg.from.endsWith("@g.us")) return;

	// 	try {
	// 		const chat = await msg.getChat();
	// 		console.log("💬 Group name of context message:", chat.name);

	// 		if (!chat.name.includes(GROUP_NAME)) return;

	// 		const contact = await msg.getContact();

	// 		const payload = {
	// 			phone: contact.number,
	// 			name: contact.pushname || "Anonymous Intern",
	// 			messageTime: new Date(msg.timestamp * 1000).toISOString(),
	// 			text: msg.body,
	// 		};

	// 		console.log("📤 Relaying payload to Google Apps Script:", payload);

	// 		const res = await axios.post(GAS_URL, JSON.stringify(payload), {
	// 			headers: { "Content-Type": "text/plain;charset=utf-8" },
	// 			maxRedirects: 5,
	// 		});
	// 		console.log("✅ Google Apps Script response received:", res.data);
	// 	} catch (msgErr) {
	// 		console.error(
	// 			"❌ Failed to process or transmit incoming message:",
	// 			msgErr.message,
	// 		);
	// 	}
	// });

	// gemini first
	client.on("message_create", async (msg) => {
		console.log(
			"📨 Message received on platform. From:",
			msg.from,
			"To:",
			msg.to,
		);

		// Check if the message is in a group (either incoming from a group, or outgoing to a group)
		const isGroup = msg.from.endsWith("@g.us") || msg.to.endsWith("@g.us");
		if (!isGroup) return;

		try {
			const chat = await msg.getChat();
			console.log("💬 Group name of context message:", chat.name);

			if (!chat.name.includes(GROUP_NAME)) return;

			// Handle "fromMe" logic to correctly identify the sender in all scenarios
			const authorJid = msg.fromMe
				? client.info.wid._serialized
				: msg.author || msg.from;
			const contact = await client.getContactById(authorJid);

			const payload = {
				phone: contact.number,
				name: contact.pushname || "Anonymous Intern",
				messageTime: new Date(msg.timestamp * 1000).toISOString(),
				text: msg.body,
			};

			console.log("📤 Relaying payload to Google Apps Script:", payload);

			const res = await axios.post(GAS_URL, JSON.stringify(payload), {
				headers: { "Content-Type": "text/plain;charset=utf-8" },
				maxRedirects: 5,
			});
			console.log("✅ Google Apps Script response received:", res.data);
		} catch (msgErr) {
			console.error(
				"❌ Failed to process or transmit incoming message:",
				msgErr.message,
			);
		}
	});

	// Trigger execution engine
	client.initialize();
	console.log(
		"⚙️ Puppeteer launching browser context... (can take up to 60 seconds)",
	);
};

process.on("uncaughtException", (err) => {
	console.error("💥 Uncaught application-level error:", err.message);
});

// Run Setup
setupAndStartBot();
