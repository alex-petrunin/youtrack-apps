import React, {memo, useCallback, useEffect, useMemo, useState} from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import {Input, Size} from '@jetbrains/ring-ui-built/components/input/input';
import LoaderInline from '@jetbrains/ring-ui-built/components/loader-inline/loader-inline';

import './app.css';

interface HostApi {
  readConfig: () => Promise<unknown>;
  storeConfig: (config: unknown) => Promise<void>;
}

declare const YTApp: {
  entity?: {id: string; type: string};
  register: () => Promise<HostApi>;
};

// Non-secret endpoint metadata, stored as a JSON string in `webhooksJson`. The signing token is
// NOT here — it lives in the write-only `webhookSecrets` map, keyed by `id`.
interface Webhook {
  id?: string;
  url?: string;
  events?: string[];
}

interface SettingsConfig {
  webhooksJson?: string;
  // Per-endpoint signing tokens keyed by webhook id. On read each value is masked ("<***>"); on write
  // a value of MASK keeps the stored token, a real value replaces it, and omitted ids are dropped.
  webhookSecrets?: Record<string, string>;
  headerName?: string;
}

interface Row {
  id: string;
  url: string;
  /** Token typed in this session. Empty means "unchanged" when {@link hasSavedSecret} is true. */
  token: string;
  /** True when a token is already stored for this id (we can never read its value back). */
  hasSavedSecret: boolean;
  events: string[];
  rowKey: string;
}

// Event types must match the `type` values in src/workflows/constants.js.
const EVENT_OPTIONS = [
  {key: 'issueCreated', label: 'Issue created'},
  {key: 'issueUpdated', label: 'Issue updated'},
  {key: 'issueDeleted', label: 'Issue deleted'},
  {key: 'commentAdded', label: 'Comment added'},
  {key: 'commentUpdated', label: 'Comment updated'},
  {key: 'commentDeleted', label: 'Comment deleted'},
  {key: 'workItemAdded', label: 'Work item added'},
  {key: 'workItemUpdated', label: 'Work item updated'},
  {key: 'workItemDeleted', label: 'Work item deleted'},
  {key: 'issueAttachmentAdded', label: 'Attachment added'},
  {key: 'issueAttachmentDeleted', label: 'Attachment deleted'},
  {key: 'allEvents', label: 'All events'},
];

const DEFAULT_HEADER = 'X-YouTrack-Token';

// The mask placeholder YouTrack returns for a stored secretMap value, and which we send back to keep
// an unchanged token. Must match SecretAttributeValue.MASK on the backend.
const SECRET_MASK = '<***>';

// Minimum signing-token length. The old JSON-schema form enforced this via `minLength` on the secret
// field (JT-95004); endpoints now live in a JSON-string + secretMap the schema can't reach, so the
// length check lives here in the widget instead.
const TOKEN_MIN_LENGTH = 32;

const newId = () => crypto.randomUUID();

interface RowErrors {
  url?: string;
  token?: string;
  events?: string;
}

function validateRow(row: Row): RowErrors {
  const errors: RowErrors = {};
  const url = row.url.trim();
  if (!url) {
    errors.url = 'Endpoint URL is required';
  } else if (!/^https?:\/\//i.test(url)) {
    errors.url = 'Enter a valid http(s) URL';
  }
  // A token is required only when none is stored yet. If one is saved, an empty field means "keep it".
  if (!row.token) {
    if (!row.hasSavedSecret) {
      errors.token = 'Signing token is required';
    }
  } else if (row.token.length < TOKEN_MIN_LENGTH) {
    errors.token = `Token must be at least ${TOKEN_MIN_LENGTH} characters`;
  }
  if (row.events.length === 0) {
    errors.events = 'Select at least one event';
  }
  return errors;
}

// Builds the secret map to submit: a freshly typed token replaces the stored one; an empty field with
// an existing secret sends the mask so the backend keeps it; rows with neither are skipped (blocked by
// validation). Endpoints removed from `rows` are omitted — the backend's per-key merge drops them.
function buildWebhookSecrets(rows: Row[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const row of rows) {
    if (row.token) {
      secrets[row.id] = row.token;
    } else if (row.hasSavedSecret) {
      secrets[row.id] = SECRET_MASK;
    }
  }
  return secrets;
}

function parseRows(json: string | undefined, savedSecretIds: Set<string>): Row[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as Webhook[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(w => {
      const id = w.id ?? newId();
      return {
        id,
        url: w.url ?? '',
        token: '',
        hasSavedSecret: savedSecretIds.has(id),
        events: Array.isArray(w.events) ? w.events : [],
        rowKey: id,
      };
    });
  } catch {
    return [];
  }
}

const AppComponent: React.FunctionComponent = () => {
  const [host, setHost] = useState<HostApi | null>(null);
  const [headerName, setHeaderName] = useState(DEFAULT_HEADER);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const h = await YTApp.register();
      setHost(h);
      const config = ((await h.readConfig()) ?? {}) as SettingsConfig;
      setHeaderName(config.headerName || DEFAULT_HEADER);
      // The secret map comes back masked; its keys tell us which endpoints already have a token.
      const savedSecretIds = new Set(Object.keys(config.webhookSecrets ?? {}));
      setRows(parseRows(config.webhooksJson, savedSecretIds));
      setLoading(false);
    })();
  }, []);

  const updateRow = useCallback((index: number, patch: Partial<Row>) => {
    setRows(prev => prev.map((row, i) => (i === index ? {...row, ...patch} : row)));
  }, []);

  const addRow = useCallback(
    () =>
      setRows(prev => {
        const id = newId();
        return [...prev, {id, url: '', token: '', hasSavedSecret: false, events: [], rowKey: id}];
      }),
    [],
  );

  const removeRow = useCallback((index: number) => setRows(prev => prev.filter((_, i) => i !== index)), []);

  const toggleEvent = useCallback((index: number, eventKey: string, checked: boolean) => {
    setRows(prev =>
      prev.map((row, i) => {
        if (i !== index) {
          return row;
        }
        const events = checked
          ? [...row.events, eventKey]
          : row.events.filter(e => e !== eventKey);
        return {...row, events};
      }),
    );
  }, []);

  const rowErrors = useMemo(() => rows.map(validateRow), [rows]);
  const hasErrors = rowErrors.some(e => e.url || e.token || e.events);

  const save = useCallback(async () => {
    if (!host || hasErrors) {
      return;
    }
    setStatus('Saving…');
    try {
      const webhooks: Webhook[] = rows.map(({id, url, events}) => ({id, url, events}));
      await host.storeConfig({
        webhooksJson: JSON.stringify(webhooks),
        webhookSecrets: buildWebhookSecrets(rows),
        headerName,
      } satisfies SettingsConfig);
      // After a successful save every row now has a stored secret; clear typed values and mark saved.
      setRows(prev => prev.map(row => ({...row, token: '', hasSavedSecret: true})));
      setStatus('✓ Saved');
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : 'error'}`);
    }
  }, [host, hasErrors, rows, headerName]);

  if (loading) {
    return <LoaderInline/>;
  }

  return (
    <div className="webhooks-settings">
      <p className="intro">
        Configure webhook endpoints for {YTApp.entity?.type === 'project' ? 'this project' : 'this app'}. Each
        endpoint has its own signing token, sent in the header below. Tokens are stored in YouTrack as write-only
        secrets — they are masked once saved and can never be read back or sent to any other host.
      </p>

      <div className="header-field">
        <Input
          size={Size.M}
          label="Token header name"
          value={headerName}
          onChange={e => setHeaderName(e.target.value)}
        />
      </div>

      <div className="rows">
        {rows.map((row, i) => (
          <div className="webhook-row" key={row.rowKey}>
            <div className="webhook-fields">
              <Input
                size={Size.FULL}
                label="Endpoint URL"
                placeholder="https://service.example.com/hook"
                value={row.url}
                error={rowErrors[i]?.url}
                onChange={e => updateRow(i, {url: e.target.value})}
              />
              <Input
                size={Size.FULL}
                label="Signing token"
                type="password"
                placeholder={row.hasSavedSecret ? 'Saved — leave blank to keep' : ''}
                value={row.token}
                error={rowErrors[i]?.token}
                onChange={e => updateRow(i, {token: e.target.value})}
              />
              <Button danger onClick={() => removeRow(i)}>Remove</Button>
            </div>
            <div className="events">
              {EVENT_OPTIONS.map(opt => (
                <Checkbox
                  key={opt.key}
                  label={opt.label}
                  checked={row.events.includes(opt.key)}
                  onChange={e => toggleEvent(i, opt.key, e.target.checked)}
                />
              ))}
            </div>
            {rowErrors[i]?.events && <div className="events-error">{rowErrors[i].events}</div>}
          </div>
        ))}
      </div>

      <div className="toolbar">
        <Button onClick={addRow}>Add endpoint</Button>
        <Button primary disabled={hasErrors} onClick={save}>Save</Button>
        <span className="status">{status}</span>
      </div>
    </div>
  );
};

export const App = memo(AppComponent);
