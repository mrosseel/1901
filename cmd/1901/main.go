// Command 1901 serves in-memory Diplomacy games.
//
// Everything it does lives in internal/app. This file exists so the top of
// the repository holds directories and not a package.
package main

import "spring1901/spike/internal/app"

func main() { app.Main() }
