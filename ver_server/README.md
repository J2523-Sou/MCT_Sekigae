# 席替え投票アプリ（ネットワーク版）

同じ Wi-Fi 内のスマホから希望席を投票し、管理者が抽選結果を一斉公開できるローカル用アプリです。外部サービスや追加パッケージは不要で、Python 3.10 以降だけで動きます。

この版は複数端末から使うための既存実装です。端末完結版とは分けて管理します。

## 起動

```sh
cd ver_server
SEATING_ADMIN_PASSWORD='任意の管理者パスワード' python3.10 app.py
```

macOS では [start.command](start.command) を Finder からダブルクリックしても起動できます。初回だけ確認が出た場合は、ファイルを Control キーを押しながらクリックして **開く** を選んでください。

管理するパソコンでは次を開きます。

```
http://localhost:8000/admin
```

パスワードを指定しない場合の初期値は `admin` です。授業などで使う前には必ず `SEATING_ADMIN_PASSWORD` を設定してください。

`start.command` は既定で `python3.10` を使用します。3.11以降を使う場合は、`SEATING_PYTHON_BIN=python3.11` を指定して起動できます。

## スマホから接続する方法

1. パソコンと全員のスマホを同じ Wi-Fi に接続します。
2. 起動したターミナルに表示される参加者用アドレスを確認します。
3. スマホのブラウザで、表示された `http://IPアドレス:8000` をそのまま開きます。`https://` や `localhost` は使いません。
4. macOS のファイアウォール確認が表示されたら、Python への受信接続を許可します。

一部の端末だけが開けない場合は、ゲスト用ネットワーク・別VLAN・VPN・端末間通信を遮断する AP isolation / client isolation を確認してください。これらはアプリ側では解消できないため、ネットワーク管理者に端末間通信の許可を依頼するか、端末間通信が許可されたネットワークを使ってください。

## 使い方

1. 管理画面でタイトルと座席の行数・列数を設定し、座席図から使わない席を個別に選びます（初期値は 5 行 × 6 列）。
2. 参加者はトップ画面で名前を入力し、希望する席を1つ選びます。除外した席は選べません。選び直しも可能です。
3. 管理画面で投票状況を確認します。
4. **投票を締め切って結果を公開** を押すと、希望者が重なった席はランダムに抽選し、残りの人へ空席をランダムに割り当てます。
5. 全員の画面は数秒以内に結果表示へ切り替わります。

投票・参加者・結果は `seating.db` に保存され、サーバーを再起動しても残ります。別の回を始めるときは管理画面の **全データをリセット** を使ってください。

## 設定できる環境変数

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `SEATING_ADMIN_PASSWORD` | `admin` | 管理画面のパスワード |
| `SEATING_PORT` | `8000` | 待受ポート |
| `SEATING_HOST` | `0.0.0.0` | 待受アドレス |

このアプリは同一ネットワーク内での短時間利用を想定しています。インターネットに直接公開しないでください。

## Azure App Service へのデプロイ

Azure App Service（Linux / Python 3.12）で実行できます。SQLite を使うため、**スケールアウトはせず常に 1 インスタンス**で運用してください。また、管理画面を公開インターネットへ出す場合は、App Service のアクセス制限または Microsoft Entra ID で管理者だけに制限してください。将来複数インスタンスにする場合は、SQLite を Azure Database for PostgreSQL などの共有データベースへ移行する必要があります。

### 必要な設定

Azure Portal の **App Service > 環境変数**、または Azure CLI で次の値をアプリ設定に登録します。値はリポジトリや `.env` ファイルにコミットしません。

| 設定名 | 必須 | 値 |
| --- | --- | --- |
| `SEATING_ADMIN_PASSWORD` | はい | 管理画面用の十分に長いパスワード |
| `SEATING_SESSION_SECRET` | はい | 32 文字以上のランダムな秘密値。再デプロイ後も変更しない |
| `SEATING_DB_PATH` | はい | `/home/data/seating.db` |

`/home` は App Service の永続ストレージです。`/home/data` 以外に SQLite を置くと、再起動や再デプロイで投票データが失われる可能性があります。

### Azure CLI での新規作成とデプロイ

Azure CLI にログイン後、以下を実行します。アプリ名は Azure 全体で一意な名前に置き換えてください。

```sh
cd ver_server
export SEATING_ADMIN_PASSWORD='十分に長い管理者パスワード'
export SEATING_SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
zip -r azure-deploy.zip app.py static requirements.txt startup.sh .deployment
sh azure-appservice-deploy.sh <リソースグループ名> <一意なアプリ名> japaneast
```

完了後、`https://<アプリ名>.azurewebsites.net/` を参加者へ、`https://<アプリ名>.azurewebsites.net/admin` を管理者へ案内します。App Service の **構成 > 全般設定** で HTTP 2.0 を有効にし、**TLS/SSL 設定** で HTTPS Only を有効にしてください。

既存の App Service に更新をデプロイする場合は、同じ zip を作り直し、次を実行します。

```sh
az webapp deploy --resource-group <リソースグループ名> --name <アプリ名> --type zip --src-path azure-deploy.zip
```
