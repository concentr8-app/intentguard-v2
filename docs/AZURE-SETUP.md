# Hosting the call server on Azure (one-time setup)

After this, every push to `main` that changes `server/` is tested and deployed by GitHub. Nobody pulls anything by hand.
Items marked (unverified) come from general knowledge, not from the Azure docs; check them in the portal.

## 1. Azure for Students
azure.microsoft.com/free/students → sign in with the @berkeley.edu mail ($100 credit, 12 months, no card).

## 2. Create the web app (portal.azure.com)
Create a resource → **Web App**:
- Publish: **Code**, Runtime stack: **Node 22 LTS**, Operating System: **Linux**
- Name: e.g. `concentr8-calls` (must be unique; the address becomes `https://<name>.azurewebsites.net`, maybe with a suffix, the portal shows it)
- Region: West US (closest to Berkeley)
- Pricing plan: **Basic B1**. The free plan gives only about an hour of CPU per day and the morning call needs a server that is always awake.

## 3. Settings of the web app
Settings → **Configuration**:
- **General settings → Always on: On** (needs Basic or higher, unverified). Without it the app unloads after 20 minutes without requests.
- **Startup command:** `node index.js`
- **Application settings** (these are the secrets; never paste them into chat):

| Name | Value |
|---|---|
| `DATA_FILE` | `/home/data/data.json` (`/home` is the persistent folder on Linux App Service, unverified) |
| `APP_API_KEY` | a new long random string (owner key) |
| `REGISTER_CODE` | the invite code you give students |
| `PUBLIC_URL` | `https://<name>.azurewebsites.net` |
| `CARTESIA_API_KEY`, `CARTESIA_AGENT_ID`, `CARTESIA_PHONE_NUMBER_ID`, `CARTESIA_WEBHOOK_SECRET` | see `CARTESIA-SETUP.md` |

If the app does not answer: Settings → Environment variables, check `PORT` (the server reads `PORT`; App Service normally provides it, unverified).

## 4. Connect GitHub
- Web app → **Overview → Download publish profile** (a file). If the button is greyed out: Settings → Configuration → General settings → turn **SCM Basic Auth Publishing Credentials** on (unverified).
- Private repo `intentguard-v2` → Settings → Secrets and variables → Actions:
  - Secret `AZURE_WEBAPP_PUBLISH_PROFILE` = the whole content of that file
  - Variable (tab "Variables") `AZURE_WEBAPP_NAME` = the web app name
- Run it: Actions → **Deploy call server** → Run workflow.

## 5. Check
`https://<name>.azurewebsites.net/api/health` shows `"ok":true`. Then put the new address into the app (Settings), into `DEFAULT_SERVER_URL` in `src/services/callServer.ts` and into the Cartesia tool URL.
