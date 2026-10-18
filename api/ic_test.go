package main

import (
	"testing"
	"time"
)

func TestParseIC(t *testing.T) {
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, myt)
	cases := []struct {
		ic      string
		dob     string
		gender  string
		age     int
		wantErr error
	}{
		{"990123125571", "1999-01-23", "LELAKI", 27, nil},
		{"650812125246", "1965-08-12", "PEREMPUAN", 61, nil},
		{"081019125571", "2008-10-19", "LELAKI", 17, nil}, // turns 18 tomorrow
		{"99012312557", "", "", 0, errICFormat},
		{"990231125571", "", "", 0, errICDate},
		{"991323125571", "", "", 0, errICDate},
	}
	for _, c := range cases {
		info, err := parseIC(c.ic, now)
		if err != c.wantErr {
			t.Fatalf("%s: err = %v, want %v", c.ic, err, c.wantErr)
		}
		if err != nil {
			continue
		}
		if got := info.DOB.Format("2006-01-02"); got != c.dob || info.Gender != c.gender || info.Age != c.age {
			t.Errorf("%s: got %s %s %d, want %s %s %d", c.ic, got, info.Gender, info.Age, c.dob, c.gender, c.age)
		}
	}
}

func TestNormalizeIC(t *testing.T) {
	if got := normalizeIC(" 990123-12-5571 "); got != "990123125571" {
		t.Fatalf("got %q", got)
	}
}
