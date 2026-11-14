//! Material-local ground anchors, resolved once when a material is loaded.
//! Motion keeps using the window origin; only its floor is adjusted for padding.

#[derive(Clone, Copy, Debug)]
pub struct GroundAnchor {
    pub y: f64,
    pub source: &'static str,
}

pub fn declared_ground(value: Option<f64>, height: f64) -> Result<Option<f64>, &'static str> {
    match value {
        Some(y) if !y.is_finite() || y <= 0. || y > height => Err("groundY must be within the material height"),
        _ => Ok(value),
    }
}

/// Ignore almost-transparent antialiasing. RGBA and BGRA share the alpha byte.
pub fn visible_bottom(width: i32, height: i32, pixels: &[u8]) -> Option<f64> {
    if width <= 0 || height <= 0 || pixels.len() != width as usize * height as usize * 4 {
        return None;
    }
    let stride = width as usize * 4;
    (0..height as usize).rev().find_map(|y| {
        pixels[y * stride..(y + 1) * stride]
            .chunks_exact(4)
            .any(|p| p[3] >= 16)
            .then_some((y + 1) as f64)
    })
}

pub fn resolve_ground(declared: Option<f64>, visible: Option<f64>, height: i32) -> GroundAnchor {
    if let Some(y) = declared {
        GroundAnchor { y, source: "material" }
    } else if let Some(y) = visible {
        GroundAnchor { y, source: "idle-alpha" }
    } else {
        GroundAnchor { y: height as f64, source: "canvas" }
    }
}

pub fn movement_bounds(area: [i32; 4], width: i32, ground: GroundAnchor, margin: i32) -> [f64; 4] {
    let [x1, y1, x2, y2] = area;
    let left = x1 + margin;
    let top = y1 + margin;
    [left as f64, top as f64, (x2 - width - margin).max(left) as f64,
        (y2 as f64 - ground.y).max(top as f64)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transparent_padding_does_not_lift_the_feet_above_the_work_area() {
        let mut pixels = vec![0; 8 * 12 * 4];
        pixels[(7 * 8 + 3) * 4 + 3] = 255;
        pixels[(10 * 8 + 3) * 4 + 3] = 3;
        let ground = resolve_ground(None, visible_bottom(8, 12, &pixels), 12);
        assert_eq!(ground.y, 8.);
        assert_eq!(ground.source, "idle-alpha");
        let bounds = movement_bounds([0, 0, 3840, 2076], 630, ground, 21);
        assert_eq!(bounds[3] + ground.y, 2076.);
        assert_eq!(bounds[2], 3189.);
    }

    #[test]
    fn explicit_material_anchor_wins_and_empty_materials_keep_the_canvas_fallback() {
        assert_eq!(resolve_ground(Some(7.5), Some(10.), 12).y, 7.5);
        assert_eq!(resolve_ground(None, None, 12).y, 12.);
        assert_eq!(visible_bottom(8, 12, &[0; 384]), None);
        assert_eq!(visible_bottom(8, 12, &[0; 3]), None);
        for value in [0., -1., 13., f64::NAN, f64::INFINITY] {
            assert!(declared_ground(Some(value), 12.).is_err());
        }
    }

    #[test]
    fn scaled_anchor_and_negative_monitor_coordinates_preserve_the_ground() {
        let anchor = resolve_ground(Some(100. * 1.75), None, 210);
        let bounds = movement_bounds([-1920, -1080, 0, -40], 300, anchor, 21);
        assert_eq!(bounds[3] + anchor.y, -40.);
        assert_eq!(bounds[0], -1899.);
    }
}
