package app.hermitty.phone

/**
 * Kody jednorazowe (logowanie, BLIK, 2FA) nie wychodzą z telefonu: w wiadomościach o kodach cyfry
 * zamieniamy na kropki. Użytkownik może to wyłączyć w aplikacji („Pokazuj kody jednorazowe”).
 */
object Mask {
    private val hint = Regex(
        "(?i)(kod|code|otp|hasł|haslo|password|passcode|\\bpin\\b|weryfik|verif|potwierdz|confirm|blik|2fa|token|logowan|login|autoryz|authori|jednorazow|one.?time|security)",
    )
    private val digits = Regex("(?<![\\d])(\\d{3}[- ]\\d{3}|\\d{4,8})(?![\\d])")

    fun apply(s: CharSequence?): String {
        val t = s?.toString() ?: return ""
        if (Store.showCodes || !hint.containsMatchIn(t)) return t
        return digits.replace(t) { m -> m.value.map { if (it.isDigit()) '•' else it }.joinToString("") }
    }
}
