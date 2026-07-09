// Package fsbrowse lists directories inside the container so the UI can offer
// a folder picker for backup sources. Directories only — file contents are
// never exposed.
package fsbrowse

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Entry is one browsable directory.
type Entry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Listing is the result of browsing one directory.
type Listing struct {
	Path    string  `json:"path"`
	Parent  string  `json:"parent,omitempty"`
	Entries []Entry `json:"entries"`
}

// Browse lists the subdirectories of path. The path is normalized and must be
// absolute; symlinks are shown but not followed for listing.
func Browse(path string) (*Listing, error) {
	if path == "" {
		path = "/"
	}
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return nil, errors.New("path must be absolute")
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}

	l := &Listing{Path: path, Entries: []Entry{}}
	if path != "/" {
		l.Parent = filepath.Dir(path)
	}
	for _, e := range entries {
		// Skip hidden entries and non-directories.
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		l.Entries = append(l.Entries, Entry{
			Name: e.Name(),
			Path: filepath.Join(path, e.Name()),
		})
	}
	sort.Slice(l.Entries, func(i, j int) bool { return l.Entries[i].Name < l.Entries[j].Name })
	return l, nil
}
