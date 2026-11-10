#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Roam,
    Dock,
    Drag,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Roam => "roaming",
            Self::Dock => "docking",
            Self::Drag => "dragging",
        }
    }
}

/// Native window origin in physical pixels. Time and speeds use seconds and DIPs.
pub struct Motion {
    pub phase: Phase,
    pub x: f64,
    pub y: f64,
    pub facing_left: bool,
    pub roam: bool,
    pub docked: bool,
    bounds: [f64; 4],
    target: f64,
    next: f64,
    lap: usize,
    anchor_offset: f64,
}

impl Motion {
    pub fn new(bounds: [f64; 4], left: bool, roam: bool) -> Self {
        let [min_x, _, max_x, floor] = bounds;
        Self {
            phase: Phase::Idle,
            x: if left { min_x } else { max_x },
            y: floor,
            facing_left: !left,
            roam,
            docked: false,
            bounds,
            target: 0.,
            next: 6.,
            lap: 0,
            anchor_offset: 0.,
        }
    }
    pub fn place_slot(&mut self, slot: usize, spacing: f64, left: bool) {
        self.anchor_offset = slot as f64 * spacing.max(0.);
        self.x = if left { self.bounds[0] + self.anchor_offset } else { self.bounds[2] - self.anchor_offset }
            .clamp(self.bounds[0], self.bounds[2]);
        self.next += slot.min(10) as f64 * 0.6;
    }
    pub fn set_home_offset(&mut self, offset: f64, left: bool) {
        let [min, _, max, _] = self.bounds;
        let home = |value: f64| if left { (min + value).min(max) } else { (max - value).max(min) };
        let at_home = self.phase == Phase::Idle && (self.x - home(self.anchor_offset)).abs() <= 1.;
        self.anchor_offset = offset.max(0.);
        if at_home { self.x = home(self.anchor_offset); }
    }
    pub fn grab(&mut self) {
        self.phase = Phase::Drag;
    }
    pub fn drag_to(&mut self, x: f64, y: f64) {
        let [left, top, right, floor] = self.bounds;
        self.x = x.clamp(left, right);
        self.y = y.clamp(top, floor);
    }
    pub fn update_bounds(&mut self, bounds: [f64; 4]) -> bool {
        if self.bounds == bounds {
            return false;
        }
        let [old_left, _, old_right, old_floor] = self.bounds;
        let [left, top, right, floor] = bounds;
        self.bounds = bounds;
        self.x = match self.phase {
            Phase::Idle if self.docked && (self.x - (old_right-self.anchor_offset).max(old_left)).abs() <= 1. => (right-self.anchor_offset).max(left),
            Phase::Idle if !self.roam && (self.x - (old_left+self.anchor_offset).min(old_right)).abs() <= 1. => (left+self.anchor_offset).min(right),
            Phase::Idle if !self.roam && (self.x - (old_right-self.anchor_offset).max(old_left)).abs() <= 1. => (right-self.anchor_offset).max(left),
            _ => self.x.clamp(left, right),
        };
        self.y = if self.phase != Phase::Drag && (self.y - old_floor).abs() <= 1. {
            floor
        } else {
            self.y.clamp(top, floor)
        };
        self.target = self.target.clamp(left, right);
        true
    }
    pub fn drop_at(&mut self, now: f64) {
        if self.phase != Phase::Drag {
            return;
        }
        self.phase = Phase::Idle;
        self.next = now + 6.;
    }
    pub fn dock(&mut self, docked: bool, now: f64) {
        if self.docked != docked {
            self.docked = docked;
            if matches!(self.phase, Phase::Roam | Phase::Dock) {
                self.phase = Phase::Idle;
            }
            self.next = now + 6.;
        }
    }
    pub fn tick(&mut self, now: f64, dt: f64, scale: f64, occupied: bool) {
        let [left, _, right, floor] = self.bounds;
        if self.phase == Phase::Drag {
            return;
        }
        if self.docked {
            let anchor = (right - self.anchor_offset).max(left);
            if (anchor - self.x).abs() > 1. || (floor - self.y).abs() > 1. {
                self.phase = Phase::Dock;
                self.target = anchor;
                self.y = (self.y + 460. * scale * dt).min(floor);
            }
        } else if occupied || !self.roam {
            self.phase = Phase::Idle;
            self.next = now + 6.;
            return;
        } else if self.phase == Phase::Idle && now >= self.next && right - left > 16. * scale {
            let distance = [135., 225., 170., 285.][self.lap % 4] * scale;
            let center = (left + right) * 0.5;
            let dir = if self.x > center { -1. } else { 1. };
            let dir = if self.lap % 2 == 0 { dir } else { -dir };
            self.target = (self.x + dir * distance).clamp(left, right);
            if (self.target - self.x).abs() < 16. * scale {
                self.target = (self.x - dir * distance).clamp(left, right);
            }
            self.lap += 1;
            self.phase = Phase::Roam;
        }
        if matches!(self.phase, Phase::Roam | Phase::Dock) {
            let delta = self.target - self.x;
            if delta.abs() > 1. {
                self.facing_left = delta < 0.;
            }
            let speed = if self.phase == Phase::Dock { 460. * scale } else { 120. * scale };
            self.x += delta.clamp(-speed * dt, speed * dt);
            if (self.target - self.x).abs() < 1. && (!self.docked || (floor - self.y).abs() < 1.) {
                self.x = self.target;
                self.phase = Phase::Idle;
                self.next = now + [15., 23., 19., 29.][self.lap % 4];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multiple_roles_have_separate_home_positions_without_restricting_dragging() {
        let mut first = Motion::new([12., 12., 1200., 800.], false, true);
        let mut second = Motion::new([12., 12., 1200., 800.], false, true);
        first.place_slot(0, 200., false);
        second.place_slot(1, 200., false);
        assert_eq!((first.x, second.x), (1200., 1000.));
        second.set_home_offset(630., false);
        assert_eq!(second.x, 570.);
        second.set_home_offset(200., false);
        assert_eq!(second.x, 1000.);
        second.grab();
        second.drag_to(1100., 800.);
        second.drop_at(0.);
        second.dock(true, 0.);
        for i in 1..=20 { second.tick(i as f64 * 0.1, 0.1, 1., false); }
        assert_eq!(second.x, 1000.);
        second.update_bounds([12., 12., 1800., 1000.]);
        assert_eq!(second.x, 1600.);
        second.update_bounds([12., 12., 100., 500.]);
        assert_eq!(second.x, 12.);
        let mut left = Motion::new([12., 12., 1200., 800.], true, false);
        left.place_slot(2, 200., true);
        assert_eq!(left.x, 412.);
    }
    #[test]
    fn shrinking_the_work_area_brings_a_roaming_avatar_back_onscreen() {
        let mut motion = Motion::new([12., 12., 3400., 1596.], false, true);
        motion.tick(7., 0.1, 1., false);
        let bounds = [12., 12., 2288., 741.];
        assert!(motion.update_bounds(bounds));
        assert_eq!((motion.x, motion.y), (2288., 741.));
        motion.tick(7.1, 0.1, 1., false);
        assert!(motion.x <= 2288. && motion.roam);
        assert!(!motion.update_bounds(bounds));
    }
    #[test]
    fn a_docked_avatar_follows_the_corner_when_the_display_expands() {
        let mut motion = Motion::new([12., 12., 900., 600.], false, true);
        motion.dock(true, 1.);
        assert!(motion.update_bounds([12., 12., 1800., 1200.]));
        assert_eq!((motion.x, motion.y), (1800., 1200.));
        assert!(motion.docked && motion.roam);
    }
    #[test]
    fn roam_holds_for_activity_and_docks_without_losing_the_setting() {
        let mut motion = Motion::new([10., 10., 900., 600.], false, true);
        motion.tick(7., 0.1, 1., false);
        assert_eq!(motion.phase, Phase::Roam);
        assert!(motion.x < 900.);
        motion.tick(7.1, 0.1, 1., true);
        let stopped = motion.x;
        motion.tick(8., 0.1, 1., true);
        assert_eq!(motion.x, stopped);
        motion.dock(true, 8.);
        motion.tick(8.1, 0.1, 1., false);
        assert_eq!((motion.x, motion.phase), (900., Phase::Idle));
        motion.dock(false, 8.1);
        motion.tick(15., 0.1, 1., false);
        assert_eq!(motion.phase, Phase::Roam);
    }
    #[test]
    fn a_frame_avatar_can_be_repositioned_by_dragging() {
        let mut motion = Motion::new([-500., 0., 500., 600.], true, false);
        motion.grab();
        motion.drag_to(-220., 280.);
        motion.drop_at(1.);
        motion.tick(1.1, 0.1, 1., false);
        assert_eq!((motion.x, motion.y, motion.phase), (-220., 280., Phase::Idle));
    }
}
