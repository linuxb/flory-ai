/** JSON, pretty-printed. No viewer library: an operator wants to select and paste it. */
export function JsonBlock({value, empty = 'nothing recorded'}: {value: unknown; empty?: string}): React.JSX.Element {
    if (value === null || value === undefined) return <p className="drawer-empty">{empty}</p>;
    return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}
