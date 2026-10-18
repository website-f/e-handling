package main

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

// Malaysian MyKad: YYMMDD-PB-###G. Last digit odd = male, even = female.

var (
	errICFormat = errors.New("ic must be 12 digits")
	errICDate   = errors.New("ic date of birth is invalid")
)

var myt = time.FixedZone("MYT", 8*3600)

type ICInfo struct {
	DOB    time.Time
	Gender string
	Age    int
}

func normalizeIC(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func parseIC(ic string, now time.Time) (ICInfo, error) {
	if len(ic) != 12 {
		return ICInfo{}, errICFormat
	}
	yy, _ := strconv.Atoi(ic[0:2])
	mm, _ := strconv.Atoi(ic[2:4])
	dd, _ := strconv.Atoi(ic[4:6])

	year := 1900 + yy
	if yy <= now.Year()%100 {
		year = 2000 + yy
	}
	dob := time.Date(year, time.Month(mm), dd, 0, 0, 0, 0, time.UTC)
	if mm < 1 || mm > 12 || dob.Day() != dd || dob.After(now) {
		return ICInfo{}, errICDate
	}

	age := now.Year() - year
	if now.Month() < time.Month(mm) || (now.Month() == time.Month(mm) && now.Day() < dd) {
		age--
	}
	gender := "PEREMPUAN"
	if (ic[11]-'0')%2 == 1 {
		gender = "LELAKI"
	}
	return ICInfo{DOB: dob, Gender: gender, Age: age}, nil
}
