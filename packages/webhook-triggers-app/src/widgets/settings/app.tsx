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

interface Webhook {
  url?: string;
  token?: string;
  events?: string[];
}

interface SettingsConfig {
  webhooksJson?: string;
  headerName?: string;
}

interface Row {
  url: string;
  token: string;
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

// Minimum signing-token length. The old JSON-schema form enforced this via `minLength` on the
// secret field (JT-95004); now that endpoints live in a JSON-string setting the schema can't reach,
// validation lives here in the custom widget instead.
const TOKEN_MIN_LENGTH = 32;

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
  if (!row.token) {
    errors.token = 'Signing token is required';
  } else if (row.token.length < TOKEN_MIN_LENGTH) {
    errors.token = `Token must be at least ${TOKEN_MIN_LENGTH} characters`;
  }
  if (row.events.length === 0) {
    errors.events = 'Select at least one event';
  }
  return errors;
}

const newRowKey = () => crypto.randomUUID();

function parseRows(json: string | undefined): Row[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as Webhook[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(w => ({
      url: w.url ?? '',
      token: w.token ?? '',
      events: Array.isArray(w.events) ? w.events : [],
      rowKey: newRowKey(),
    }));
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
      setRows(parseRows(config.webhooksJson));
      setLoading(false);
    })();
  }, []);

  const updateRow = useCallback((index: number, patch: Partial<Row>) => {
    setRows(prev => prev.map((row, i) => (i === index ? {...row, ...patch} : row)));
  }, []);

  const addRow = useCallback(
    () => setRows(prev => [...prev, {url: '', token: '', events: [], rowKey: newRowKey()}]),
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
      const webhooks: Webhook[] = rows.map(({url, token, events}) => ({url, token, events}));
      await host.storeConfig({webhooksJson: JSON.stringify(webhooks), headerName} satisfies SettingsConfig);
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
        endpoint has its own signing token, sent in the header below. Tokens are stored in YouTrack and, thanks to
        the widget&apos;s Content-Security-Policy, can never be sent to any other host.
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