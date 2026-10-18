package main

import (
	"context"
	"hash/fnv"
)

// DEMO_FALLBACK: any valid, unregistered IC gets a deterministic fictional voter so a live
// demo never dead-ends. Date of birth and gender still come from the IC itself.

var demoNames = map[string][]string{
	"LELAKI": {
		"MOHD SAIFUL BIN JAINAL", "JOSEPH MOJINIP", "WONG KAH HENG", "AHMAD FAIZAL BIN ROSLI",
		"RAYMOND GANSUNG", "MUHAMMAD HAZIQ BIN SAMSUDIN", "LEE JUN WEI", "ABDUL HALIM BIN BAKAR",
	},
	"PEREMPUAN": {
		"NURUL AIN BINTI HASSAN", "MARY ANN JUNIAH", "CHIN MEI LING", "SITI HAJAR BINTI ISMAIL",
		"JULIANA MAJUNGKI", "NOR AZIZAH BINTI ADNAN", "FLORENCE LIEW SU FEN", "ROSNAH BINTI ALI",
	},
}

func (a *App) createDemoVoter(ctx context.Context, ic string, info ICInfo) (Voter, error) {
	h := fnv.New32a()
	h.Write([]byte(ic))
	sum := h.Sum32()

	names := demoNames[info.Gender]
	name := names[int(sum%uint32(len(names)))]
	locality := a.localities[int((sum>>8)%uint32(len(a.localities)))]

	_, err := a.db.Exec(ctx, `INSERT INTO voters (ic, full_name, dob, gender, locality_code, is_demo)
		VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (ic) DO NOTHING`,
		ic, name, info.DOB, info.Gender, locality)
	if err != nil {
		return Voter{}, err
	}
	return a.voterFromDB(ctx, ic)
}
