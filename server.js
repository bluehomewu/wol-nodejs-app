const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http'); // 使用 http
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const ping = require('ping');
const bcrypt = require('bcrypt');

const app = express();
const PORT = 5000; // 如果 NAS 上 5000 被佔用，請改為其他數字 (例如 5050)
const DEVICES_FILE = path.join(__dirname, 'devices.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- 讀取設定檔 ---
let HASHED_PASSWORD;
try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    HASHED_PASSWORD = config.hashedPassword;
    if (!HASHED_PASSWORD) {
        throw new Error('在 config.json 中找不到 hashedPassword');
    }
} catch (error) {
    console.error('致命錯誤：無法讀取或解析 config.json！', error);
    process.exit(1);
}

// --- 中介軟體 ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 輔助函數 ---
const loadDevices = async () => {
    try {
        const data = await fs.promises.readFile(DEVICES_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error("無法讀取 devices.json:", error);
        return [];
    }
};

const sendMagicPacket = (mac) => {
    return new Promise((resolve, reject) => {
        exec(`wakeonlan ${mac}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`執行 wakeonlan 失敗: ${stderr}`);
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
};

// --- HTTP API 端點 ---
app.post('/api/devices', async (req, res) => {
    const { password } = req.body;
    const isMatch = await bcrypt.compare(password, HASHED_PASSWORD);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: "密碼錯誤！" });
    }
    const devices = await loadDevices();
    res.json({ success: true, devices });
});

// --- 設定 HTTP 與 WebSocket 伺服器 ---
const server = http.createServer(app); 
const wss = new WebSocketServer({ server });

// --- WebSocket 邏輯 ---
wss.on('connection', (ws) => {
    console.log('前端 WebSocket 已連線');
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'wakeup') {
                const { password, mac, ip, name } = data.payload;
                
                const isMatch = await bcrypt.compare(password, HASHED_PASSWORD);
                if (!isMatch) {
                    ws.send(JSON.stringify({ type: 'log', message: '錯誤：未授權的操作！' }));
                    ws.send(JSON.stringify({ type: 'done', success: false }));
                    return;
                }

                const initialProbe = await ping.promise.probe(ip, { timeout: 2 });
                if (initialProbe.alive) {
                    ws.send(JSON.stringify({ type: 'log', message: `${name} 已經是醒著的！` }));
                    ws.send(JSON.stringify({ type: 'done', success: true }));
                    return;
                }
                await sendMagicPacket(mac);
                ws.send(JSON.stringify({ type: 'log', message: `喚醒指令已送出，等待 ${name} 醒過來...` }));
                let isAwake = false;
                const attempts = 15;
                const interval = 6000;
                for (let i = 0; i < attempts; i++) {
                    await new Promise(resolve => setTimeout(resolve, interval));
                    const probe = await ping.promise.probe(ip, { timeout: 2 });
                    if (probe.alive) {
                        ws.send(JSON.stringify({ type: 'log', message: `Ping ${i + 1}...是醒著的！` }));
                        isAwake = true;
                        break;
                    } else {
                        ws.send(JSON.stringify({ type: 'log', message: `Ping ${i + 1}...依然睡死！` }));
                    }
                }
                if (!isAwake) {
                    ws.send(JSON.stringify({ type: 'log', message: `${name} 在指定時間內沒有回應。` }));
                }
                ws.send(JSON.stringify({ type: 'done', success: isAwake }));
            }
        } catch (error) {
            console.error('處理 WebSocket 訊息時出錯:', error);
            ws.send(JSON.stringify({ type: 'log', message: '伺服器內部錯誤。' }));
            ws.send(JSON.stringify({ type: 'done', success: false }));
        }
    });
    ws.on('close', () => {
        console.log('前端 WebSocket 已斷線');
    });
});

// --- 啟動伺服器 ---
// 注意：在 Docker Host 模式下，我們監聽 0.0.0.0 讓外部（NAS 的網路介面）可以存取
server.listen(PORT, '0.0.0.0', () => {
    console.log(`WOL HTTP 伺服器正在 http://0.0.0.0:${PORT} 上運行`);
});
