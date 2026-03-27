# SHOPLINE POS Order Hook to Meta Custom Audience / Conversions API

這個專案用來接收 SHOPLINE webhook 訂單資料，篩選出實體門市 POS 訂單後，將去識別化後的客戶資料與購買事件送到 Meta (Facebook)。

目前程式的行為重點如下：

- 只處理 `req.body.resource` 內的訂單資料。
- 只接受 `created_by` 為 `pos` 的訂單，其餘來源一律略過。
- 只送出 7 天內的事件，避免 Meta 拒收過舊資料。
- 會先對 email、電話、姓名做 SHA-256 雜湊，再送到 Meta。
- 即使送 Meta 失敗，也會回傳 HTTP 200 給 SHOPLINE，避免 webhook 一直重送。

## 適用情境

如果你想把 SHOPLINE 門市 POS 成交資料回傳給 Meta，讓廣告系統可以用於：

- 廣告成效歸因
- 實體門市購買事件回傳
- 後續自訂受眾 / 類似受眾優化

這個專案就是為這個流程準備的。

## 專案流程

1. SHOPLINE 發送 webhook 到 Google Cloud Function。
2. Function 讀取訂單資料 `req.body.resource`。
3. Function 檢查事件時間與來源是否符合條件。
4. Function 將 email / phone / name 標準化並做 SHA-256 雜湊。
5. Function 呼叫 Meta Graph API `/{PIXEL_ID}/events` 送出 `Purchase` 事件。

## 程式使用的環境變數

本專案需要兩個 Secret，並在部署時注入成環境變數：

| 變數名稱 | 用途 |
| --- | --- |
| `FB_PIXEL_ID` | Meta Pixel ID。Meta 新版介面中，Dataset ID 與 Pixel ID 相同。 |
| `FB_ACCESS_TOKEN` | Meta Conversions API 的 Access Token，用於呼叫 Graph API。 |

## 先決條件

部署前請先準備好以下項目：

- 一個 Google Cloud 專案
- 已安裝並登入 `gcloud` CLI
- 一個可使用的 Meta Business / Events Manager 帳號
- 可以建立或查看 Pixel / Dataset 的權限
- 可以產生 Conversions API Access Token 的權限
- SHOPLINE webhook 設定權限

## 建議執行環境

建議使用 Google Cloud Functions 2nd gen 搭配 `nodejs22`。

## 如何找到 `FB_PIXEL_ID`

Meta 官方說明指出，現在 Events Manager 會逐步將 event sources 合併為 dataset，且 **Dataset ID 與 Pixel ID 相同**。實務上你可以把這個值當作這支程式要用的 `FB_PIXEL_ID`。

操作方式：

1. 進入 [Meta Events Manager](https://business.facebook.com/events_manager2/)。
2. 選擇你要接收事件的 Pixel / Dataset。
3. 進入該資料來源的設定頁。
4. 找到 Pixel ID 或 Dataset ID。
5. 把這個值記下來，之後存進 GCP Secret Manager 的 `FB_PIXEL_ID`。

如果你還沒有 Pixel，可先依 Meta 官方說明建立：

1. 進入 Events Manager。
2. 點 `Connect data`。
3. 選 `Offline`。
4. 建立新的 Pixel。
5. 建立完成後即可在 Events Manager 中看到這個 ID。
6. 把這個值存起來，之後放進 GCP Secret Manager 的 `FB_PIXEL_ID`。

## 如何找到 `FB_ACCESS_TOKEN`

這個值是 Meta Conversions API 用來驗證伺服器事件的 Access Token。

在目前 Meta 介面中，通常可以依照這個路徑找到：

1. 進入 [Meta Events Manager](https://business.facebook.com/events_manager2/)。
2. 選擇你剛剛使用的 Pixel / Dataset。
3. 進入 `Settings`。
4. 往下找到 `透過 Dataset Quality API 設定` 區塊。
5. 選擇產生存取權杖。
6. 產生或複製 Access Token。
7. 把這個值存起來，之後放進 GCP Secret Manager 的 `FB_ACCESS_TOKEN`。

## 將值存到 GCP Secret Manager

這個專案的設計是由 Google Secret Manager 注入環境變數，不把敏感資訊直接寫進原始碼。

### 方式一：用 Google Cloud Console

1. 打開 [Secret Manager](https://console.cloud.google.com/security/secret-manager)。
2. 點 `Create Secret`。
3. Secret name 輸入 `FB_PIXEL_ID`。
4. Secret value 貼上你的 Pixel ID。
5. 再建立一次 Secret，名稱輸入 `FB_ACCESS_TOKEN`。
6. Secret value 貼上你的 Meta Access Token。

### 方式二：用 `gcloud` CLI

先設定目前專案：

```bash
gcloud config set project YOUR_PROJECT_ID
```

啟用必要 API：

```bash
gcloud services enable secretmanager.googleapis.com cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

建立 `FB_PIXEL_ID`：

```bash
printf "%s" "YOUR_PIXEL_ID" | gcloud secrets create FB_PIXEL_ID --replication-policy="automatic" --data-file=-
```

建立 `FB_ACCESS_TOKEN`：

```bash
printf "%s" "YOUR_META_ACCESS_TOKEN" | gcloud secrets create FB_ACCESS_TOKEN --replication-policy="automatic" --data-file=-
```

如果 Secret 已存在，要更新內容請新增版本：

```bash
printf "%s" "YOUR_PIXEL_ID" | gcloud secrets versions add FB_PIXEL_ID --data-file=-
printf "%s" "YOUR_META_ACCESS_TOKEN" | gcloud secrets versions add FB_ACCESS_TOKEN --data-file=-
```

## 建立 Cloud Function 執行用 Service Account

建議不要直接用預設 Compute Engine service account，改用專用帳號比較好管理。

建立 service account：

```bash
gcloud iam service-accounts create shopline-fb-hook-sa --display-name="SHOPLINE Facebook Hook"
```

假設你的專案 ID 是 `YOUR_PROJECT_ID`，那這個 service account 會是：

```text
shopline-fb-hook-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

## 讓 Function 可以讀取 Secret

Cloud Functions / Cloud Run function 的執行身分必須有 Secret Manager 讀取權限，否則部署或執行時會出現權限錯誤。

把 `Secret Manager Secret Accessor` 權限加到兩個 Secret：

```bash
gcloud secrets add-iam-policy-binding FB_PIXEL_ID \
  --member="serviceAccount:shopline-fb-hook-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

```bash
gcloud secrets add-iam-policy-binding FB_ACCESS_TOKEN \
  --member="serviceAccount:shopline-fb-hook-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## 部署到 Google Cloud Functions

本專案假設：

- 程式入口檔案是 `index.js`
- Function 名稱是 `shp_FB`
- 專案根目錄已經有 `package.json`

在專案根目錄執行：

```bash
gcloud functions deploy shopline-pos-facebook-hook \
  --gen2 \
  --runtime=nodejs22 \
  --region=asia-east1 \
  --source=. \
  --entry-point=shp_FB \
  --trigger-http \
  --allow-unauthenticated \
  --service-account=shopline-fb-hook-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-secrets=FB_PIXEL_ID=FB_PIXEL_ID:latest,FB_ACCESS_TOKEN=FB_ACCESS_TOKEN:latest \
  --memory=256Mi \
  --timeout=60s
```

### 為什麼要 `--allow-unauthenticated`

因為 SHOPLINE webhook 發送 HTTP 請求時，不會附帶 GCP IAM 驗證憑證，所以這支 HTTP Function 必須能接受公開請求，否則 SHOPLINE 打不到你的 endpoint。

### 部署成功後會拿到什麼

部署完成後，Google Cloud 會提供一個 HTTPS URL，例如：

```text
https://asia-east1-YOUR_PROJECT_ID.cloudfunctions.net/shopline-pos-facebook-hook
```

把這個 URL 填到 SHOPLINE webhook 設定即可。

## 在 SHOPLINE 設定 Webhook

### 方式一：用 SHOPLINE API REFERENCE

因為我們只需要建立一個 webhook，所以可以直接在 SHOPLINE API REFERENCE設定。(https://open-api.docs.shoplineapp.com/reference/post_webhooks)
輸入Credentials跟address，topics選擇order/create，然後點try it就好。

### 方式二：用 curl

```json
curl --request POST \
     --url https://open.shopline.io/v1/webhooks \
     --header 'accept: application/json' \
     --header 'authorization: Bearer YOUR_SHOPLINE_ACCESS_TOKEN' \
     --header 'content-type: application/json' \
     --data '
{
  "webhook_version": "v0",
  "address": "https://asia-east1-YOUR_PROJECT_ID.cloudfunctions.net/shopline-pos-facebook-hook",
  "topics": [
    "order/create"
  ]
}
'
```

## 本專案目前送到 Meta 的事件內容

程式會送出以下資訊：

- `event_id`: 訂單 ID
- `event_name`: `Purchase`
- `action_source`: `physical_store`
- `user_data.em`: 雜湊後 email
- `user_data.ph`: 雜湊後電話
- `user_data.fn`: 雜湊後姓名
- `custom_data.currency`: 訂單幣別
- `custom_data.value`: 訂單金額

## 過濾規則

以下情況會直接略過，不送 Meta：

- `req.body.resource` 不存在
- 訂單建立時間早於現在往前 7 天
- `created_by` 不是 `pos`
- email 與 phone 都無法使用

## 驗證部署是否成功

### 1. 看 Cloud Logging

部署完成後，到 Google Cloud Logs Explorer 查看：

- 是否有 `✅ Sent event to Facebook`
- 是否有 `❌ Error sending to Facebook`

如果是有 `Order from non-pos source (shop), skipping event.`，代表你設定的 webhook 觸發了，但這筆訂單不是 POS 建立的，所以被程式略過了。

### 2. 看 Meta Events Manager

到 Events Manager 檢查是否有收到 server-side `Purchase` 事件。

## 常見問題

### 1. `No order data`

代表 webhook body 中沒有 `req.body.resource`。

請先檢查：

- SHOPLINE 傳來的 payload 結構
- 是否有經過中介服務改寫 body

### 2. Meta 回傳權限錯誤或無法寫入事件

常見原因：

- `FB_PIXEL_ID` 填錯
- `FB_ACCESS_TOKEN` 填錯
- Pixel 與 token 不是同一個資料來源
- Meta 帳號權限不足

### 3. GCP 部署成功，但執行時抓不到 Secret

常見原因：

- 沒有把 Secret 綁到 `--set-secrets`
- 執行的 service account 沒有 `roles/secretmanager.secretAccessor`

### 4. SHOPLINE 一直打不到 webhook

請檢查：

- Function 是否使用 `--trigger-http`
- 是否加了 `--allow-unauthenticated`
- SHOPLINE 填的是正確的 HTTPS URL

## 安全注意事項

- 不要把 `FB_ACCESS_TOKEN` 直接寫在 `index.js`。
- 不要把 Secret 放進 GitHub。
- 建議使用專用 service account，不要全部共用預設帳號。
- 目前這份程式沒有驗證 SHOPLINE webhook 簽章；如果你要正式上線，建議補上來源驗證、反向代理保護或 API Gateway / Cloud Armor。
- 目前程式會在 Meta 發送失敗時仍回 200 給 SHOPLINE，這能避免重送，但你必須另外監控 Cloud Logging。

## 參考文件

- [Meta Business Help Center: About Conversions API](https://www.facebook.com/business/help/AboutConversionsAPI)
- [Meta Help Center: Set up and install the Meta pixel](https://www.facebook.com/help/messenger-app/952192354843755/)
- [Google Cloud: Deploy a function](https://cloud.google.com/functions/docs/deploy)
- [Google Cloud SDK: gcloud functions deploy](https://docs.cloud.google.com/sdk/gcloud/reference/functions/deploy)
- [Google Cloud: Create and access a secret using Secret Manager](https://docs.cloud.google.com/secret-manager/docs/create-secret-quickstart)
- [Google Cloud: Manage access to secrets](https://docs.cloud.google.com/secret-manager/docs/manage-access-to-secrets)
- [Google Cloud: Configure secrets for services](https://cloud.google.com/run/docs/configuring/services/secrets)
- [Google Cloud: Runtime support](https://docs.cloud.google.com/functions/docs/runtime-support)

## 補充說明

這份 README 以目前這份程式邏輯為前提：

- 入口函式名稱是 `shp_FB`
- 使用 `process.env.FB_PIXEL_ID`
- 使用 `process.env.FB_ACCESS_TOKEN`
- 使用 `axios` 呼叫 `https://graph.facebook.com/{API_VERSION}/{PIXEL_ID}/events`

如果你之後修改了檔名、函式名稱、payload 結構或部署區域，請同步更新 README 內對應指令。
