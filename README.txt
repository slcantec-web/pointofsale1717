Session: stay logged in + idle lock + 24h full logout
=====================================================

Overwrite:
  app.js
  dashboard.html
  admin.html
  index.html
  style.css
  worker.js   (token lifetime = 24h)

Behaviour
---------
1) Close app / browser tab → stay logged in (token in localStorage)
2) Reopen → back into the till (no login form) if under 24h
3) No activity for 20 minutes → lock screen; password unlocks
4) After 24 hours → full logout; must log in again

Unlock uses the same email + password (email is stored at login).
If you logged in before this update, log out once and log in again
so the email is saved for unlock.
