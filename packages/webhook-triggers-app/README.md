# YouTrack Webhook Triggers App

[![official JetBrains project](https://jb.gg/badges/official-flat-square.svg)](https://github.com/JetBrains#jetbrains-on-github)

Trigger external webhooks from YouTrack events such as issue creation, updates, deletion, comments, work items, and attachments.

## Features

- **Event types**: Issue (create/update/delete), Comments, Work Items, Attachments (add/update/delete).
- **Per-endpoint configuration**: every webhook endpoint has its own URL, signing token, and set of subscribed events — managed in a custom project settings widget.
- **Secret safety**: tokens are entered in the settings widget, which runs under a Content-Security-Policy (`connect-src 'self'`) that prevents them from being sent anywhere but YouTrack.

## Configuration

Open your project → **Settings → Apps → Webhook Triggers → Webhooks**. The widget lets you:

1. Set the **token header name** (default `X-YouTrack-Token`) used for every request.
2. **Add endpoints** — for each one provide:
   - **Endpoint URL** — the receiver. `https://` is strongly recommended; private/loopback/link-local addresses are blocked (SSRF protection).
   - **Signing token** — a per-endpoint secret. Generate a strong value, e.g. `openssl rand -hex 32`, and configure the same value in that endpoint's receiver. A token-less endpoint is skipped (fail closed).
   - **Events** — tick the events this endpoint should receive, or **All events** for a catch-all.

Each endpoint is sent only its own token, so compromising one receiver never exposes another's secret. Up to 10 endpoints are dispatched per event.

> **Validation lives in the widget.** Because endpoints are stored as a single JSON-string setting,
> the JSON-schema form can't validate them. The widget enforces it instead: each endpoint needs a
> valid http(s) URL, a signing token of at least 32 characters, and at least one event before Save
> is enabled. The backend stays the authoritative safety net (SSRF URL checks; token-less endpoints
> are skipped).

### Configure Your Webhook Receiver

Your webhook receiver (e.g., n8n) must be configured to validate the signatures.

#### For n8n

1. Install the `n8n-nodes-youtrack` package
2. Add "YouTrack Trigger" node to your workflow
3. Configure **YouTrack Webhook Auth API** credential:
   - **Authentication Method**: `Header Auth`
   - **Header Name**: must match the token header name set in the widget (e.g. `X-YouTrack-Token`)
   - **Secret Key**: the same token you set for this endpoint in the widget

4. Select events to listen for
5. Activate the workflow
6. Copy the webhook URL and paste it into YouTrack app settings

## Webhook Payload Format

All payloads share a common base structure with event-specific fields added.

### Base Payload Structure

Every webhook payload includes these fields:

```json
{
  "event": "eventType",
  "timestamp": "2024-12-10T12:00:00.000Z",
  "id": "2-123",
  "numberInProject": 123,
  "summary": "Issue title",
  "project": {
    "id": "project-id",
    "name": "Project Name",
    "shortName": "PROJECT"
  }
}
```

### User Object Structure

When a user is included in the payload:

```json
{
  "login": "username",
  "fullName": "User Name",
  "email": "user@example.com"
}
```

### Issue Created

```json
{
  "event": "issueCreated",
  "timestamp": "2024-12-10T12:00:00.000Z",
  "id": "2-123",
  "numberInProject": 123,
  "summary": "Issue title",
  "project": { "id": "...", "name": "...", "shortName": "..." },
  "description": "Issue description text",
  "created": 1732708800000,
  "reporter": { "login": "...", "fullName": "...", "email": "..." }
}
```

### Issue Updated
**Important**: you will see one 'field change' item in changedFields array per webhook request if issue was amended manually via UI.
```json
{
  "event": "issueUpdated",
  "timestamp": "2024-12-10T12:00:00.000Z",
  "id": "2-123",
  "numberInProject": 123,
  "summary": "Issue title",
  "project": { "id": "...", "name": "...", "shortName": "..." },
  "description": "Issue description text",
  "updated": 1732708800000,
  "updatedBy": { "id": "...", "login": "...", "fullName": "...", "email": "..." },
  "changedFields": [
    {
      "name": "summary",
      "oldValue": "Old title",
      "value": "New title"
    }
  ]
}
```

### Issue Deleted

```json
{
  "event": "issueDeleted",
  "timestamp": "2024-12-10T12:00:00.000Z",
  "id": "2-123",
  "numberInProject": 123,
  "summary": "Issue title",
  "project": { "id": "...", "name": "...", "shortName": "..." },
  "description": "Issue description text"
}
```

### Comment Added / Updated / Deleted

```json
{
  "event": "commentAdded",
  "timestamp": "2024-12-10T12:00:00.000Z",
  "id": "2-123",
  "numberInProject": 123,
  "summary": "Issue title",
  "project": { "id": "...", "name": "...", "shortName": "..." },
  "comments": [
    {
      "id": "comment-id",
      "text": "Full comment text",
      "textPreview": "Comment preview...",
      "created": 1732708800000,
      "updated": 1732708800000,
      "author": { "id": "...", "login": "...", "fullName": "...", "email": "..." }
    }
  ]
}
```

Event types: `commentAdded`, `commentUpdated`, `commentDeleted`

### Work Item Added / Updated / Deleted

```json
{
  "event": "workItemAdded",
  "timestamp": "2024-12-10T12:00:00.000Z",
  "id": "2-123",
  "numberInProject": 123,
  "summary": "Issue title",
  "project": { "id": "...", "name": "...", "shortName": "..." },
  "workItems": [
    {
      "id": "work-item-id",
      "date": 1732708800000,
      "duration": 3600000,
      "description": "Work description",
      "created": 1732708800000,
      "updated": 1732708800000,
      "author": { "id": "...", "login": "...", "fullName": "...", "email": "..." },
      "type": { "id": "type-id", "name": "Development" }
    }
  ]
}
```

Event types: `workItemAdded`, `workItemUpdated`, `workItemDeleted`

### Attachment Added / Deleted

```json
{
  "event": "issueAttachmentAdded",
  "timestamp": "2024-12-10T12:00:00.000Z",
  "id": "2-123",
  "numberInProject": 123,
  "summary": "Issue title",
  "project": { "id": "...", "name": "...", "shortName": "..." },
  "attachments": [
    {
      "name": "file.pdf",
      "mimeType": "application/pdf",
      "size": 12345,
      "created": 1732708800000,
      "author": { "id": "...", "login": "...", "fullName": "...", "email": "..." }
    }
  ]
}
```

Event types: `issueAttachmentAdded`, `issueAttachmentDeleted`

## Security

### HTTP Headers

Each webhook includes the following headers:

```
Content-Type: application/json
<Header-Name>: <your-secret-token>
```

The header name is configurable (defaults to `X-YouTrack-Token`); the value is the per-endpoint signing token configured for that webhook in the widget.

## Limitations

### Per-event endpoint cap
Up to 10 endpoints are dispatched per event (the async-function chain limit). Extra endpoints are dropped with a warning in the app logs.

### Request timeout
Each webhook request times out after 5 seconds. Ensure your receivers respond promptly, or use a fast intermediary that acknowledges immediately and processes asynchronously.

## Credits

Developed for use with [n8n workflow automation](https://n8n.io/) and YouTrack issue tracking.
