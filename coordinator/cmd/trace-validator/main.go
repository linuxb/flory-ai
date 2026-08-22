// Command trace-validator checks a recorded JSON event array against S2 trace invariants.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/linuxb/flory-ai/coordinator/internal/trace"
)

func main() {
	var events []trace.Event
	if err := json.NewDecoder(os.Stdin).Decode(&events); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := trace.Validate(events); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
