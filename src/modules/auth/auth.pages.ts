// Minimal pages that the links in verification / reset emails open. They stand in for a real frontend.
//
// Two rules shape them:
// 1. Opening the page must NOT use the token. Email scanners and link previews open links
//    automatically; if a GET verified the email, a bot could burn the token before the user clicks.
//    So the page only shows a button, and the button sends the POST.
// 2. The token arrives after "#" (the URL fragment). Browsers never send the fragment to the server,
//    so it can't show up in access logs, proxies or Referer headers. The page's script reads it.

import { Router, type Response } from "express";

export const authPagesRouter = Router();

authPagesRouter.get("/verify-email", (_req, res) => {
    sendPage(res, "Verify your email", `
        <p>Click the button to confirm your email address.</p>
        <button id="go">Verify email</button>`, `
        document.getElementById("go").onclick = async (e) => {
            e.target.disabled = true;
            await submit("/auth/verify-email", { token }, "Your email is verified. You can log in now.");
        };`);
});

authPagesRouter.get("/reset-password", (_req, res) => {
    sendPage(res, "Choose a new password", `
        <form id="form">
            <label>New password <input id="pw" type="password" minlength="8" maxlength="128" required autocomplete="new-password"></label>
            <label>Confirm password <input id="pw2" type="password" minlength="8" maxlength="128" required autocomplete="new-password"></label>
            <button>Reset password</button>
        </form>`, `
        document.getElementById("form").onsubmit = async (e) => {
            e.preventDefault();
            const password = document.getElementById("pw").value;
            if (password !== document.getElementById("pw2").value) return show("Passwords don't match.", true);
            e.target.querySelector("button").disabled = true;
            await submit("/auth/reset-password", { token, password }, "Password changed. Log in with your new password.");
        };`);
});

// The page is static: nothing from the request is put into the HTML, so there's nothing to escape.
function sendPage(res: Response, title: string, body: string, script: string): void {
    res.set({
        "Cache-Control": "no-store",     // don't keep a copy of a page that handles a token
        "Referrer-Policy": "no-referrer", // never send this page's URL to anyone
    });
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · IRCTC</title>
<style>
    body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
    label { display: block; margin: .75rem 0; }
    input { display: block; width: 100%; padding: .5rem; margin-top: .25rem; box-sizing: border-box; }
    button { padding: .6rem 1.2rem; font-size: 1rem; cursor: pointer; }
    #msg { margin-top: 1rem; padding: .75rem; border-radius: 6px; }
    #msg.ok { background: #e6f4ea; } #msg.err { background: #fce8e6; }
    #msg:empty { display: none; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
<p id="msg" role="status"></p>
<script>
    // Prefer the fragment (#token=...); fall back to ?token= for older links. Then wipe it from the
    // address bar so it isn't left in browser history or copied along with the URL.
    const params = new URLSearchParams(location.hash.slice(1) || location.search);
    const token = params.get("token");
    history.replaceState(null, "", location.pathname);

    function show(text, isError) {
        const el = document.getElementById("msg");
        el.textContent = text;
        el.className = isError ? "err" : "ok";
    }

    async function submit(url, body, successText) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            if (res.ok) return show(successText, false);
            const data = await res.json().catch(() => null);
            show(data?.error?.message ?? "Something went wrong (" + res.status + ")", true);
        } catch {
            show("Couldn't reach the server. Check your connection and try again.", true);
        }
        document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }

    if (!token) {
        show("This link is missing its token. Open it straight from the email.", true);
        document.querySelectorAll("button").forEach((b) => (b.disabled = true));
    }
    ${script}
</script>
</body>
</html>`);
}
