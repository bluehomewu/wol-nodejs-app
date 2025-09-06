# 遠端喚醒 (Wake-on-LAN) 網頁服務

一個輕量、現代化的 Wake-on-LAN (WOL) 網頁伺服器，專為在 Raspberry Pi 或其他家用 Linux 主機上 24/7 運行而設計。透過簡潔的網頁介面，您可以在區域網路內安全地喚醒您的電腦。

## 功能特色

*   **現代化前端介面**：乾淨、響應式的單頁應用，在手機和桌面瀏覽器上都有良好體驗。
*   **即時日誌反饋**：使用 WebSocket 實現，喚醒過程中的每一步 `ping` 結果都會即時推送到前端，進度一目了然。
*   **安全優先**：
    *   支援 HTTPS (透過自簽 SSL 證書)。
    *   密碼使用 `bcrypt` 進行雜湊儲存，不暴露明文。
    *   設定與程式碼分離，敏感資訊儲存在外部設定檔中。
*   **設定簡單**：所有裝置與密碼設定都透過外部 JSON 檔案管理，無需修改程式碼。
*   **為 Raspberry Pi 優化**：採用輕量化的 Node.js 技術棧，資源佔用低，並提供完整的 `systemd` 開機自啟動設定教學。

## 技術棧

*   **後端**: Node.js, Express, WebSocket (`ws`)
*   **密碼學**: bcrypt
*   **前端**: HTML, CSS, JavaScript (無框架)
*   **部署**: Systemd

---

## 部署指南

本指南以 Raspberry Pi OS (Debian-based) 為範例。

### 1. 環境準備

首先，確保您的系統已安裝 `git`、`nvm` (或 Node.js) 以及 `wakeonlan` 工具。

```bash
# 更新系統
sudo apt update && sudo apt upgrade

# 安裝 wakeonlan 工具
sudo apt install wakeonlan git

# 安裝 nvm 並安裝 Node.js LTS 版本 (推薦)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# 讓 nvm 生效
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
# 安裝並使用 Node LTS
nvm install --lts
```

### 2. 取得專案並安裝依賴

```bash
# 從 GitHub 複製您的專案
git clone <你的專案Repo網址>
cd <專案資料夾名稱>

# 安裝 Node.js 依賴
npm install
```

### 3. 進行設定

#### a. 設定要喚醒的裝置 (`devices.json`)

複製範本檔案，並根據您的裝置資訊進行修改。

```bash
cp devices.example.json devices.json
nano devices.json
```

檔案格式如下，您可以新增多個裝置：
```json
[
    {
        "name": "Desktop",
        "mac": "xx:xx:xx:xx:xx:xx",
        "ip": "192.168.1.1"
    },
    {
        "name": "Server",
        "mac": "xx:xx:xx:xx:xx:xx",
        "ip": "192.168.1.2"
    }
]
```

#### b. 產生 SSL 證書

為了使用 HTTPS，我們需要一組自簽 SSL 證書。

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -sha256 -days 3650 -nodes -subj "/CN=localhost"
```
此指令會在專案根目錄產生 `key.pem` 和 `cert.pem` 兩個檔案。

#### c. 設定密碼 (`config.json`)

我們不會將明文密碼儲存起來。請跟隨以下步驟：

1.  **產生密碼雜湊**：專案內附一個指令碼 `hash-generator.js`。執行它來產生密碼的 `bcrypt` 雜湊值。
    ```bash
    # 將 "你的安全密碼" 換成您想設定的實際密碼
    node hash-generator.js "你的安全密碼"
    ```
2.  **複製產生的雜湊值**：複製終端機輸出的完整雜湊字串 (以 `$2b$...` 開頭)。

3.  **建立設定檔**：
    ```bash
    nano config.json
    ```
4.  將以下內容貼入，並將 `hashedPassword` 的值替換為您剛剛複製的雜湊值：
    ```json
    {
        "hashedPassword": "貼上你複製的雜湊值"
    }
    ```

### 4. 手動測試

在設定為開機自啟動前，先手動執行一次，確保所有設定都正確無誤。

```bash
npm start
```

如果看到 `WOL HTTPS 伺服器正在 https://0.0.0.0:5000 上運行` 的訊息，代表伺服器已成功啟動。您可以打開瀏覽器訪問 `https://<你的Pi的IP>:5000` 進行測試 (瀏覽器會提示憑證不安全，請選擇「繼續前往」)。

### 5. 設定開機自啟動 (Systemd)

1.  **建立 `systemd` 服務檔案**：
    ```bash
    sudo nano /etc/systemd/system/wol-node.service
    ```

2.  **貼入以下設定**：
    **注意：** 請務必根據您的實際情況，修改 `User`、`WorkingDirectory` 和 `ExecStart` 中的使用者名稱與路徑。
    ```ini
    [Unit]
    Description=Node.js Wake On LAN Web Service
    # 確保在網路連線後才啟動
    After=network.target

    [Service]
    User=pi
    Group=pi
    WorkingDirectory=/home/pi/wol-nodejs-app
    # 直接執行 node，而不是 npm，這樣更穩定
    ExecStart=/home/pi/.nvm/versions/node/v22.19.0/bin/node /home/pi/wol-nodejs-app/server.js
    
    # 如果服務失敗，自動重啟
    Restart=always
    RestartSec=10

    [Install]
    WantedBy=multi-user.target
    ```
    > **提示**: 您可以透過 `whoami` 取得使用者名稱，`pwd` 取得當前目錄路徑，`which node` 取得 node 的絕對路徑。

3.  **啟動並設定開機自啟動**：
    ```bash
    # 讓 systemd 讀取新的設定檔
    sudo systemctl daemon-reload
    # 立即啟動服務
    sudo systemctl start wol-node.service
    # 設定開機時自動啟動
    sudo systemctl enable wol-node.service
    ```

4.  **檢查服務狀態**：
    ```bash
    sudo systemctl status wol-node.service
    ```
    如果看到 `Active: active (running)`，恭喜您，部署已全部完成！

## 如何使用

服務啟動後，在同一個區域網路下的任何裝置（手機、電腦），打開瀏覽器訪問 `https://<你的主機IP>:5000` 即可。


# Notes
本專案由 Google Gemini-2.5 Pro 完成，有沒有 bug 或是漏洞我不知道，這個 Tool 只是讓我方便使用，請自行斟酌使用。

我自己先前使用的是 [Remote-Wake-Sleep-On-LAN-Server](https://github.com/bluehomewu/Remote-Wake-Sleep-On-LAN-Server/tree/main) 這個專案，但由於他的前端介面好醜，而且有點過於複雜以及回應不夠即時，所以我就自己用 Google Gemini 2.5 Pro 寫了一個。  
這種東西應該沒有什麼太複雜的邏輯，所以我連 README.md 都讓 Gemini 幫我寫了，省得我自己打字 XD。

