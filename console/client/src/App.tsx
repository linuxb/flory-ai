import {useCallback, useEffect, useState} from 'react';
import {AppShell} from './shell/AppShell.js';
import {ThemeProvider} from './theme/ThemeProvider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run in the address bar, so a canvas can be linked to in an incident channel. */
function runFromHash(): string | null {
    const value = globalThis.location?.hash.replace(/^#\/?run\//, '') ?? '';
    return UUID.test(value) ? value : null;
}

export function App(): React.JSX.Element {
    const [runId, setRunId] = useState<string | null>(runFromHash);

    useEffect(() => {
        const listen = () => setRunId(runFromHash());
        globalThis.addEventListener('hashchange', listen);
        return () => globalThis.removeEventListener('hashchange', listen);
    }, []);

    // A hash rather than a router: one route, and pasting the URL into a channel has to work.
    const open = useCallback((next: string | null) => {
        globalThis.location.hash = next ? `#/run/${next}` : '';
    }, []);

    return (
        <ThemeProvider>
            <AppShell runId={runId} onOpenRun={open} />
        </ThemeProvider>
    );
}
