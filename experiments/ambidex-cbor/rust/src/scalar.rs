use crate::cbor::Value as C;
use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, SecondsFormat, Utc};
/// Exact Decimal coefficient fits i128 because this profile caps precision at 38.
#[derive(Clone, Debug, PartialEq)]
pub struct Decimal {
    pub coefficient: i128,
    pub scale: i32,
}
impl Decimal {
    pub fn parse(text: &str) -> Result<Self, String> {
        if text.len() > 1100 || text.is_empty() {
            return Err("decimal length".into());
        }
        let (mut body, negative) = (text, false);
        if let Some(s) = text.strip_prefix('-') {
            body = s;
        }
        let negative = negative || text.starts_with('-');
        let parts: Vec<_> = body.split('e').collect();
        if parts.len() > 2 {
            return Err("decimal syntax".into());
        }
        let exp = if parts.len() == 2 {
            let e = parts[1];
            if e.len() > 5 {
                return Err("decimal exponent".into());
            }
            let v: i32 = e.parse().map_err(|_| "exponent")?;
            if v.to_string() != e {
                return Err("exponent canonical".into());
            }
            v
        } else {
            0
        };
        let pieces: Vec<_> = parts[0].split('.').collect();
        if pieces.len() > 2 {
            return Err("decimal syntax".into());
        }
        let whole = pieces[0];
        if whole.is_empty()
            || whole.len() > 1 && whole.starts_with('0')
            || !whole.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("decimal syntax".into());
        }
        let fraction = pieces.get(1).copied().unwrap_or("");
        if pieces.len() == 2 && fraction.is_empty() || !fraction.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("decimal fraction".into());
        }
        let digits = whole.to_owned() + fraction;
        let significant = digits.trim_start_matches('0');
        if significant.len().max(1) > 38 {
            return Err("decimal precision".into());
        }
        let scale = fraction.len() as i32 - exp;
        if scale.abs() > 1000 {
            return Err("decimal scale".into());
        }
        let mut coefficient: i128 = digits.parse().map_err(|_| "coefficient")?;
        if negative {
            coefficient = -coefficient;
        }
        Ok(Self { coefficient, scale })
    }
    pub fn text(&self) -> String {
        if self.scale < 0 {
            return format!("{}e{}", self.coefficient, -self.scale);
        }
        let sign = if self.coefficient < 0 { "-" } else { "" };
        let mut digits = self.coefficient.abs().to_string();
        let scale = self.scale as usize;
        if digits.len() <= scale {
            digits = "0".repeat(scale + 1 - digits.len()) + &digits;
        }
        if scale > 0 {
            let at = digits.len() - scale;
            digits.insert(at, '.');
        }
        format!("{sign}{digits}")
    }
    pub fn cbor(&self) -> C {
        let n = self.coefficient;
        let mantissa = if (-18446744073709551616..=18446744073709551615).contains(&n) {
            C::Int(n)
        } else {
            let magnitude = if n < 0 { (-1 - n) as u128 } else { n as u128 };
            let b = magnitude.to_be_bytes();
            let start = b.iter().position(|b| *b != 0).unwrap_or(15);
            C::Tag(
                if n < 0 { 3 } else { 2 },
                Box::new(C::Bytes(b[start..].to_vec())),
            )
        };
        C::Tag(
            4,
            Box::new(C::Array(vec![C::Int(-self.scale as i128), mantissa])),
        )
    }
    pub fn from_cbor(v: &C) -> Result<Self, String> {
        let C::Tag(4, inner) = v else {
            return Err("decimal tag".into());
        };
        let C::Array(a) = inner.as_ref() else {
            return Err("decimal array".into());
        };
        if a.len() != 2 {
            return Err("decimal arity".into());
        }
        let C::Int(e) = a[0] else {
            return Err("exponent integer".into());
        };
        if !(-1000..=1000).contains(&e) {
            return Err("scale".into());
        }
        let n = match &a[1] {
            C::Int(n) => *n,
            C::Tag(t, v) if *t == 2 || *t == 3 => {
                let C::Bytes(b) = v.as_ref() else {
                    return Err("bignum".into());
                };
                let mut n = 0u128;
                for b in b {
                    n = n
                        .checked_mul(256)
                        .and_then(|x| x.checked_add(*b as u128))
                        .ok_or("coefficient overflow")?;
                }
                if n > i128::MAX as u128 {
                    return Err("coefficient overflow".into());
                }
                if *t == 3 { -1 - n as i128 } else { n as i128 }
            }
            _ => return Err("mantissa".into()),
        };
        const MAX_COEFFICIENT: i128 = 10i128.pow(38) - 1;
        if !(-MAX_COEFFICIENT..=MAX_COEFFICIENT).contains(&n) {
            return Err("decimal precision".into());
        }
        let d = Self {
            coefficient: n,
            scale: -e as i32,
        };
        Self::parse(&d.text())
    }
}
pub fn temporal(s: &str, kind: &str) -> Result<String, String> {
    if s.len() > 64 || !s.is_ascii() {
        return Err("temporal length".into());
    }
    fn date(s: &str) -> bool {
        s.len() == 10
            && s.as_bytes()[4] == b'-'
            && s.as_bytes()[7] == b'-'
            && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
    }
    fn time(s: &str) -> bool {
        if s.len() < 8 || s.as_bytes()[2] != b':' || s.as_bytes()[5] != b':' {
            return false;
        }
        if let Some((_, frac)) = s.split_once('.') {
            if frac.is_empty() || frac.len() > 9 || !frac.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
        } else if s.len() != 8 {
            return false;
        }
        if s.get(6..8).is_some_and(|x| x == "60") {
            return false;
        }
        NaiveTime::parse_from_str(s, "%H:%M:%S%.f").is_ok()
    }
    match kind {
        "date" if date(s) => Ok(s.into()),
        "time" if time(s) => Ok(s.into()),
        "local"
            if s.len() >= 19 && s.as_bytes()[10] == b'T' && date(&s[..10]) && time(&s[11..]) =>
        {
            Ok(s.into())
        }
        "duration" => {
            let body = s
                .strip_prefix('-')
                .unwrap_or(s)
                .strip_prefix("PT")
                .and_then(|x| x.strip_suffix('S'))
                .ok_or("duration")?;
            let parts: Vec<_> = body.split('.').collect();
            if parts.len() > 2
                || parts[0].is_empty()
                || parts[0].len() > 1 && parts[0].starts_with('0')
                || !parts[0].bytes().all(|b| b.is_ascii_digit())
                || parts.len() == 2
                    && (parts[1].is_empty()
                        || parts[1].len() > 9
                        || !parts[1].bytes().all(|b| b.is_ascii_digit()))
            {
                return Err("duration".into());
            }
            Ok(s.into())
        }
        "instant" => {
            if s.len() < 20 || s.as_bytes()[10] != b'T' || !date(&s[..10]) {
                return Err("instant".into());
            }
            let offset = if s.ends_with('Z') { 1 } else { 6 };
            if s.len() < 19 + offset || s.ends_with("-00:00") {
                return Err("offset".into());
            }
            let end = s.len() - offset;
            if !time(&s[11..end]) {
                return Err("instant time".into());
            }
            let dt = DateTime::parse_from_rfc3339(s)
                .map_err(|_| "instant")?
                .with_timezone(&Utc);
            if !(0..=9999).contains(&dt.year()) {
                return Err("year".into());
            }
            let base = dt.to_rfc3339_opts(SecondsFormat::Secs, true);
            let fraction = s[11..end]
                .split_once('.')
                .map(|(_, f)| format!(".{f}"))
                .unwrap_or_default();
            Ok(base.trim_end_matches('Z').to_owned() + &fraction + "Z")
        }
        _ => Err("temporal".into()),
    }
}
