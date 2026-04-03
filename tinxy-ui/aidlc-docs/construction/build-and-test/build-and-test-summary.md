# Build and Test Summary — Tinxy Light Control UI

## Build Instructions

This is a zero-dependency static web application. No build step is required.

### To Run Locally
1. Open `tinxy-ui/index.html` directly in any modern browser (Chrome, Firefox, Edge, Safari)
2. Or serve with any static server:
   ```bash
   # Python
   python -m http.server 8080 --directory tinxy-ui
   # Node.js (npx)
   npx serve tinxy-ui
   ```
3. Navigate to `http://localhost:8080`

---

## Manual Test Checklist

### Authentication
- [ ] Token screen displays on first visit
- [ ] Entering empty token shows error message
- [ ] Entering invalid token shows API error message
- [ ] Entering valid token navigates to dashboard
- [ ] Token is persisted in localStorage (refresh page → stays logged in)
- [ ] Logout button clears token and returns to token screen

### Device Listing
- [ ] Dashboard shows loading spinner while fetching
- [ ] All devices from GET /v2/devices/ appear as cards
- [ ] Device name and type are displayed correctly
- [ ] Empty account shows "No devices found" message
- [ ] API error shows error state with retry button

### Device State
- [ ] Each device card shows ON/OFF badge (or "?" if state fetch fails)
- [ ] State dot on each node row reflects current state (green = ON)
- [ ] Multi-node device shows one row per switch

### Device Toggle
- [ ] Clicking toggle changes visual state immediately after API success
- [ ] Toggle shows disabled state while API call is in flight
- [ ] Status bar notification appears after toggle
- [ ] Toggle failure shows error message in status bar

### Responsive
- [ ] Layout looks correct on mobile (< 480px)
- [ ] Layout looks correct on desktop (> 1024px)
