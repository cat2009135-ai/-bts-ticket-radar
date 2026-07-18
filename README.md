# BTS 高雄場公開售票雷達

這是一個個人用、唯讀的公開售票資訊監看器。GitHub Actions 約每 5 分鐘檢查一次官方 Live Nation Taiwan 活動頁；偵測到公開售票區塊變動時，透過 LINE Messaging API 通知你，再由你自行前往拓元確認。

## 重要限制

- 這不是搶票程式，不會自動選位、加入購物車、登入、驗證或購票。
- 程式只讀取官方公開活動頁，不抓取拓元的選位、票區、驗證或購票頁面。
- Live Nation 公開頁面沒有變動時，拓元內部若單獨出現退票／零星座位，本監看器可能偵測不到。
- 收到通知不代表一定有票；最終狀態一律以[拓元官方活動頁](https://tixcraft.com/activity/detail/26_btskns)顯示為準。
- GitHub 的排程可能因平台負載而延遲，不保證精準在每個第 5 分鐘執行。

## 監看來源

- [2026/11/19 BTS WORLD TOUR 'ARIRANG' IN KAOHSIUNG](https://www.livenation.com.tw/en/event/bts-world-tour-arirang-in-kaohsiung-kaohsiung-tickets-edp1675883)
- [2026/11/21、11/22 BTS WORLD TOUR 'ARIRANG' IN KAOHSIUNG](https://www.livenation.com.tw/en/event/bts-world-tour-arirang-in-kaohsiung-kaohsiung-tickets-edp1675887)

## 第一次啟用

請勿把 LINE Token 或 User ID 寫進程式、README、Issue，或貼在公開畫面。

1. 進入此 repository 的 **Settings**。
2. 選 **Secrets and variables** → **Actions**。
3. 按 **New repository secret**，新增：
   - 名稱：`LINE_CHANNEL_ACCESS_TOKEN`；內容：你的 LINE Channel access token。
   - 名稱：`LINE_USER_ID`；內容：你的 LINE User ID。
4. 進入 **Actions** → **BTS 公開售票雷達** → **Run workflow**。
5. 第一次成功執行後，LINE 會收到「BTS 釋票雷達已啟動」。之後只有公開頁面狀態變化才會通知。

GitHub Actions Secrets 會加密保存，程式不會把兩個秘密值印到執行紀錄。

## 檔案說明

- `monitor.mjs`：抓取與比對官方公開售票區塊，必要時發送 LINE。
- `.github/workflows/bts-ticket-monitor.yml`：每 5 分鐘與手動執行排程。
- `.monitor-state.json`：首次成功執行後建立，只保存公開頁面指紋與文字摘要，不含 LINE 機密。
- `.monitor-heartbeat`：每 30 天更新一次，避免長期無通知時公開 repository 的排程被 GitHub 自動停用。

## 本機安全測試

不傳送 LINE 的測試方式：

```bash
DRY_RUN=1 \
MONITOR_STATE_PATH=/tmp/bts-monitor-state.json \
MONITOR_HEARTBEAT_PATH=/tmp/bts-monitor-heartbeat \
node monitor.mjs
```
