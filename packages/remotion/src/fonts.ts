import { loadFont as loadAnton } from "@remotion/google-fonts/Anton"
import { loadFont as loadBebas } from "@remotion/google-fonts/BebasNeue"
import { loadFont as loadInter } from "@remotion/google-fonts/Inter"
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat"
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins"
import { loadFont as loadTikTokSans } from "@remotion/google-fonts/TikTokSans"
import { FONT_WEIGHTS, type FontName } from "@clipforge/shared"

// typed per font by the loader's own weight union (inferred from where it's passed)
const w = <T extends string>(f: FontName) => FONT_WEIGHTS[f].weights.map(String) as T[]

// Loaded once per page; the renderer waits for them automatically (delayRender inside loadFont).
// Every weight in FONT_WEIGHTS is loaded so the hook's weight control renders the real cut.
const montserrat = loadMontserrat("normal", { weights: w("Montserrat"), subsets: ["latin"] })
const inter = loadInter("normal", { weights: w("Inter"), subsets: ["latin"] })
const bebas = loadBebas("normal", { weights: w("Bebas Neue"), subsets: ["latin"] })
const anton = loadAnton("normal", { weights: w("Anton"), subsets: ["latin"] })
const poppins = loadPoppins("normal", { weights: w("Poppins"), subsets: ["latin"] })
const tiktok = loadTikTokSans("normal", { weights: w("TikTok Sans"), subsets: ["latin"] })

export const FONT_FAMILIES: Record<FontName, { family: string; weight: number }> = {
  Montserrat: { family: montserrat.fontFamily, weight: FONT_WEIGHTS.Montserrat.default },
  Inter: { family: inter.fontFamily, weight: FONT_WEIGHTS.Inter.default },
  "Bebas Neue": { family: bebas.fontFamily, weight: FONT_WEIGHTS["Bebas Neue"].default },
  Anton: { family: anton.fontFamily, weight: FONT_WEIGHTS.Anton.default },
  Poppins: { family: poppins.fontFamily, weight: FONT_WEIGHTS.Poppins.default },
  "TikTok Sans": { family: tiktok.fontFamily, weight: FONT_WEIGHTS["TikTok Sans"].default },
}
