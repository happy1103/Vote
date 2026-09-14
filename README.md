# 即時投票網站（GitHub Pages + Firebase）

這是一個手機優先的五階段即時圖片投票網站。

## 入口

- 投票者：`/`
- 主持人：`/host/`

主持人網址不需要公開給投票者。

## 投票流程

1. 第 1 階段：A vs B
2. 第 2 階段：C vs D
3. 第 3 階段：E vs F
4. 第 4 階段：前三階段勝者三選一
5. 第 5 階段：第 4 階段勝者 vs 種子 G

點圖片就會立即投票，不能修改。投票後，選中的圖片保持原樣，其他圖片變暗。

主持人可以：

- 建立場次與設定 A～G 圖片
- 開放每一階段投票
- 查看「已投票 / 已加入」人數
- 公布結果
- 同票時指定晉級者（公開票數仍保留實際同票結果）
- 自己也能在主持人頁投票
- 完成五階段後結束場次

投票者在全部完成後會看到「自己的選擇 vs 全體勝出結果」。

## 1. 套用 Firestore Security Rules

Firebase Console → Firestore Database → 規則（Rules）

把 `firestore.rules` 的全部內容貼上，然後按「發布」。

> 不要使用允許所有人任意讀寫的測試規則。

## 2. 上傳到 GitHub

把這個資料夾的檔案上傳到 GitHub repository 根目錄：

- `index.html`
- `voter.js`
- `shared.js`
- `firebase-config.js`
- `styles.css`
- `host/index.html`

`firestore.rules` 與 `README.md` 可以保留在 repository 中，不會影響網站。

## 3. 開啟 GitHub Pages

GitHub repository → Settings → Pages

- Source：Deploy from a branch
- Branch：`main`
- Folder：`/(root)`

儲存後等待 GitHub Pages 發布。

例如 repository 名稱是 `vote`：

- 投票者：`https://你的帳號.github.io/vote/`
- 主持人：`https://你的帳號.github.io/vote/host/`

## 4. 主持人操作

1. 開啟 `/host/`
2. 選擇 A～G 七張圖片
3. 按「建立場次」
4. 把 6 位數場次代碼或「複製投票連結」分享給大家
5. 開放第 1 階段
6. 大家投得差不多後按「顯示結果」
7. 再按「開放下一階段」
8. 第 5 階段結果公布後按「結束場次並顯示最終比較」

## 重要注意事項

### 主持人權限綁定目前瀏覽器

第一版使用 Firebase Anonymous Authentication。主持人的 Firebase UID 會保存在目前瀏覽器中，因此：

- 不要在場次進行中清除這個網站的瀏覽器資料 / Cookie / Site Data。
- 建議整場都使用同一台裝置與同一個瀏覽器主持。
- 如果清掉瀏覽器資料，新的匿名 UID 無法接管舊場次。

### 圖片

圖片會在主持人瀏覽器內先縮到最大約 900 px，再壓縮成 WebP / JPEG，然後存到 Firestore 的候選項目文件中。每張圖會被限制在 Firestore 單文件大小限制以下。

這個方式適合小型活動與少量候選圖片。若之後要大量場次、保留大量原圖或多人長期使用，建議再改成 Firebase Storage / Cloud Storage。

### 同票

若某階段最高票同票，主持人會看到一個「指定晉級者」區塊。選定後：

- 公開票數仍顯示真正的同票結果
- 被指定者作為下一階段晉級者

## Firebase 設定

本專案已使用你提供的 Firebase Web App 設定：`vote-9664c`。

使用的 Firebase 功能：

- Authentication → Anonymous
- Cloud Firestore

不需要 Firebase Hosting，也不需要 npm。
