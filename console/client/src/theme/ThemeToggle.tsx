import {useTheme, type ThemePreference} from './ThemeProvider.js';

const OPTIONS: ThemePreference[] = ['light', 'auto', 'dark'];

/** The explicit override the repository's theming rule requires alongside auto-following. */
export function ThemeToggle(): React.JSX.Element {
    const {preference, setPreference} = useTheme();
    return (
        <div className="theme-toggle" role="group" aria-label="Colour theme">
            {OPTIONS.map((option) => (
                <button key={option} type="button" aria-pressed={preference === option} onClick={() => setPreference(option)}>
                    {option}
                </button>
            ))}
        </div>
    );
}
