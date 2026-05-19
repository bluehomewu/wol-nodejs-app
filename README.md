# 遠端喚醒 Wake-on-LAN 網頁服務

一個輕量的 Wake-on-LAN 控制台，適合放在 Raspberry Pi、NAS 或家用 Linux 主機上長時間運行。前端登入後可選擇 `devices.json` 內的裝置並送出喚醒指令，後端會透過 WebSocket 回傳即時 ping 狀態。

## 功能特色

- 單頁控制台，支援桌面與手機版面。
- WebSocket 自動重連，分頁離開或網路短暫中斷後會嘗試恢復連線。
- 喚醒工作使用 job id 保存進度；重新連線後會重播已收到的日誌。
- 密碼以 `bcrypt` 雜湊存放在 `config.json`。
- 登入成功後使用短期 HttpOnly cookie session，WebSocket 不再傳送密碼。
- 後端只接受伺服器端 `devices.json` 內的裝置 ID，不信任前端傳來的 MAC/IP。
- `wakeonlan` 使用 `execFile` 執行，並驗證 MAC/IP 格式，避免 shell 字串插值。
- 內建登入速率限制與基本安全標頭。

## 技術棧

- 後端：Node.js、Express、`ws`
- 密碼：bcrypt
- 前端：HTML、CSS、JavaScript
- 系統工具：`wakeonlan`

## 安全提醒

這個服務會觸發內網裝置喚醒，而且你有開放外網存取，請至少做到：

- Node app 固定提供 HTTP，不內建 HTTPS；外網入口請交給 nginx 反代。
- 不要直接把 Node HTTP 服務裸露到 Internet。
- `config.json`、`devices.json`、`key.pem`、`cert.pem` 已在 `.gitignore`，不要提交到 Git。
- 使用長密碼，避免重用其他服務的密碼。
- 若曾經公開過舊版服務，建議更換密碼並重新產生 `config.json` 內的 bcrypt hash。
- 若 `devices.json` 內有無效 MAC/IP，後端會忽略該裝置。

## 安裝

以下以 Debian/Raspberry Pi OS 為例。

```bash
sudo apt update
sudo apt install wakeonlan git

# 使用你偏好的方式安裝 Node.js LTS，例如 nvm
nvm install --lts

git clone <你的專案 Repo URL>
cd wol-nodejs-app
npm install
```

## 設定

### 1. 裝置清單

```bash
cp devices.example.json devices.json
nano devices.json
```

格式：

```json
[
  {
    "name": "Desktop",
    "mac": "AA:BB:CC:DD:EE:FF",
    "ip": "192.168.1.10"
  }
]
```

### 2. 登入密碼

產生 bcrypt hash：

```bash
node hash-generator.js "你的安全密碼"
```

建立 `config.json`：

```json
{
  "hashedPassword": "貼上 node hash-generator.js 產生的完整 hash"
}
```

也可以在 `config.json` 指定 port：

```json
{
  "hashedPassword": "貼上 hash",
  "port": 5050
}
```

或用環境變數覆蓋：

```bash
PORT=5050 npm start
```

## 執行

```bash
npm start
```

預設會監聽：

```text
http://0.0.0.0:5000
```

在同一台主機測試：

```bash
curl -I http://127.0.0.1:5000
```

## 外網部署建議

建議讓 Node app 只在內部網路或本機可達，外網入口交給 nginx。TLS 憑證、網域、存取限制都應該在 nginx 層處理，Node app 不需要也不會讀取 `cert.pem` 或 `key.pem`。

Nginx 範例：

```nginx
server {
    listen 443 ssl http2;
    server_name wol.example.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

如果你只在內網使用，也可以讓 nginx 用純 HTTP 反代到 `127.0.0.1:5000`；重點是不要把 Node app 本身直接暴露到公網。

## Systemd

建立服務檔：

```bash
sudo nano /etc/systemd/system/wol-node.service
```

範例內容，請依實際路徑修改 `User`、`WorkingDirectory`、`ExecStart`：

```ini
[Unit]
Description=Node.js Wake-on-LAN Web Service
After=network.target

[Service]
User=pi
Group=pi
WorkingDirectory=/home/pi/wol-nodejs-app
ExecStart=/home/pi/.nvm/versions/node/v22.19.0/bin/node /home/pi/wol-nodejs-app/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

啟用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wol-node.service
sudo systemctl status wol-node.service
```

## 測試與安全檢查

```bash
npm test
npm audit --omit=dev
```

目前測試涵蓋：

- 裝置清單只接受有效 MAC/IP。
- `wakeonlan` 不透過 shell 字串插值執行。
- 無效 MAC 不會被送去執行。
- session token 會過期。
- 登入失敗會觸發速率限制。

## 更新紀錄

- 改為登入後 HttpOnly cookie session。
- WebSocket 支援自動重連與 job 日誌恢復。
- 喚醒 API 改為只傳 `deviceId`。
- 修補命令注入風險與依賴套件 advisory。
- 更新控制台 UI 與 README。
