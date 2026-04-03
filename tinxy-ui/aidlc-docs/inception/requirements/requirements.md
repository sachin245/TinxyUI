# Requirements Document — Tinxy Light Control UI

## Intent Analysis

| Field | Value |
|---|---|
| User Request | Build a web UI that takes a Tinxy API token and allows toggling smart lights on/off |
| Request Type | New Project (Greenfield) |
| Scope Estimate | Single Component (static web app) |
| Complexity Estimate | Moderate |
| API Documentation | https://tinxyapi.pages.dev/ |

---

## Functional Requirements

### FR-01: API Token Input
- The UI must present a token input field on first load
- The token must be sent as `Authorization: Bearer <token>` on all API calls
- The token must be saved in `localStorage` so the user does not re-enter it each visit
- A "Logout / Clear Token" button must allow clearing the saved token

### FR-02: Device Listing
- After token entry, the UI must call `GET https://backend.tinxy.in/v2/devices/` with Bearer auth
- All returned devices must be displayed as cards in a dashboard grid

### FR-03: Device State Display
- For each device, query `GET https://backend.tinxy.in/v2/devices/{deviceId}/state?deviceNumber=1` to get current ON/OFF state
- Display a visual indicator (colored badge/icon) showing current state

### FR-04: Device Toggle
- Each device card must have a toggle button (ON / OFF)
- Clicking toggle calls `POST https://backend.tinxy.in/v2/devices/{deviceId}/toggle` with:
  ```json
  { "request": { "state": 1, "brightness": 0 }, "deviceNumber": 1 }
  ```
  where `state` = 1 for ON, 0 for OFF
- The UI must update the displayed state after a successful toggle

### FR-05: Multi-Node Device Support
- If a device has multiple nodes/switches, display each node as a separate row within the card
- Each node has its own toggle (deviceNumber 1, 2, 3...)

### FR-06: Error Handling
- Display user-friendly error messages for failed API calls (invalid token, network error, etc.)
- Show a loading spinner while fetching devices/states

---

## Non-Functional Requirements

### NFR-01: Technology Stack
- Pure HTML5 / CSS3 / Vanilla JavaScript (no build step, open directly in browser)
- No external framework dependencies that require npm/bundler
- Minimal CDN dependencies only (optional: a CSS utility for icons)

### NFR-02: Usability
- Dark theme dashboard aesthetic
- Responsive layout — works on desktop and mobile

### NFR-03: Security (Prototype Level)
- API token stored in localStorage (acceptable for personal prototype)
- No token logging or exposure in URLs

---

## API Reference (from documentation)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `https://backend.tinxy.in/v2/devices/` | List all devices |
| GET | `https://backend.tinxy.in/v2/devices/{id}/state?deviceNumber=N` | Get device state |
| POST | `https://backend.tinxy.in/v2/devices/{id}/toggle` | Toggle device on/off |

**Auth Header**: `Authorization: Bearer <token>`
**Content-Type**: `application/json`

---

## Decisions / Assumptions

- **No build step**: Single `.html` + `.css` + `.js` files openable directly in browser
- **Token persistence**: localStorage with logout capability
- **State polling**: Fetch state on load and after each toggle (no WebSocket/long-poll)
- **Multi-node**: Devices with `noOfDevices > 1` get individual per-node toggle buttons
