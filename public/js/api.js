export async function fetchMe() {
  const res = await fetch('/api/me', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch session (${res.status})`);
  }
  return res.json();
}

export async function fetchBoardSnapshot() {
  const res = await fetch('/api/board', {
    credentials: 'same-origin',
    cache: 'no-cache',
  });
  if (!res.ok) {
    throw new Error(`Failed to load board (${res.status})`);
  }
  const seq = Number(res.headers.get('X-Board-Seq') || 0);
  const checked = Number(res.headers.get('X-Board-Checked') || 0);
  const instanceId = res.headers.get('X-Instance-Id') || '';
  const buffer = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    seq,
    checked,
    instanceId,
  };
}

export async function postLogout() {
  const res = await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  });
  return res.ok;
}

