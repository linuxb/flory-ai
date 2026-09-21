import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';

/**
 * Light, dark, or follow the system — the convention every visual in this repository keeps.
 *
 * `auto` removes the attribute entirely and lets the media query in tokens.css decide, which is
 * the same mechanism the diagrams use, so both are maintained by one mental model.
 */
export type ThemePreference = 'light' | 'dark' | 'auto';

export interface ThemeContextValue {
    preference: ThemePreference;
    setPreference(next: ThemePreference): void;
    /** What is on screen now, with `auto` resolved. React Flow's colorMode is a JS prop. */
    resolved: 'light' | 'dark';
}

const STORAGE_KEY = 'flory.console.theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

function stored(): ThemePreference {
    try {
        const value = localStorage.getItem(STORAGE_KEY);
        return value === 'light' || value === 'dark' ? value : 'auto';
    } catch {
        return 'auto';
    }
}

export function ThemeProvider({children}: {children: ReactNode}): React.JSX.Element {
    const [preference, setStatePreference] = useState<ThemePreference>(stored);
    const [systemDark, setSystemDark] = useState(() => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);

    useEffect(() => {
        const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
        if (!query) return;
        const listen = (event: MediaQueryListEvent) => setSystemDark(event.matches);
        query.addEventListener('change', listen);
        return () => query.removeEventListener('change', listen);
    }, []);

    useEffect(() => {
        if (preference === 'auto') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', preference);
    }, [preference]);

    const setPreference = useCallback((next: ThemePreference) => {
        setStatePreference(next);
        try {
            if (next === 'auto') localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // A console that cannot remember a preference is still a working console.
        }
    }, []);

    const value = useMemo<ThemeContextValue>(
        () => ({preference, setPreference, resolved: preference === 'auto' ? (systemDark ? 'dark' : 'light') : preference}),
        [preference, setPreference, systemDark],
    );
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const value = useContext(ThemeContext);
    if (!value) throw new Error('useTheme outside a ThemeProvider');
    return value;
}
