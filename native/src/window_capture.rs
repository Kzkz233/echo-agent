//! Window-local frames remove excluded overlays without exposing occluded, unapproved pixels.
//! Sessions are short-lived: no capture stream survives the requested local sample.
use crate::Rect;
use image::RgbImage;
use std::{
    cell::RefCell,
    sync::mpsc,
    time::{Duration, Instant},
};

thread_local! {
    // Reuse the graphics device, not the capture session or any screen pixels.
    // Creating a new device for each 1 Hz probe is substantially more expensive.
    static DEVICE: RefCell<Option<Device>> = const { RefCell::new(None) };
}
pub fn with_device<T>(capture: impl FnOnce(&Device) -> Result<T, String>) -> Result<T, String> {
    DEVICE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.is_none() {
            *cache = Some(Device::new()?);
        }
        let result = capture(cache.as_ref().unwrap());
        if result.is_err() {
            cache.take();
        }
        result
    })
}
pub fn release_device() {
    DEVICE.with(|cache| {
        cache.borrow_mut().take();
    });
}
use windows::{
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::{HWND, RECT},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP},
            Direct3D11::*,
            Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
            Dxgi::IDXGIDevice,
        },
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
        },
        UI::WindowsAndMessaging::GetWindowRect,
    },
    core::{Interface, factory},
};

struct Snapshot {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

pub struct Device {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    projected: IDirect3DDevice,
}
impl Device {
    pub fn new() -> Result<Self, String> {
        unsafe {
            let mut device = None;
            let mut context = None;
            let create = |driver,
                          device: &mut Option<ID3D11Device>,
                          context: &mut Option<ID3D11DeviceContext>| {
                D3D11CreateDevice(
                    None,
                    driver,
                    windows::Win32::Foundation::HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(device),
                    None,
                    Some(context),
                )
            };
            if create(D3D_DRIVER_TYPE_HARDWARE, &mut device, &mut context).is_err() {
                create(D3D_DRIVER_TYPE_WARP, &mut device, &mut context)
                    .map_err(|_| "窗口采集设备不可用")?;
            }
            let device = device.ok_or("窗口采集设备不可用")?;
            let context = context.ok_or("窗口采集上下文不可用")?;
            let dxgi: IDXGIDevice = device.cast().map_err(|_| "窗口采集设备接口不可用")?;
            let projected = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)
                .and_then(|v| v.cast())
                .map_err(|_| "Windows 窗口采集接口不可用")?;
            Ok(Self {
                device,
                context,
                projected,
            })
        }
    }
    pub fn copy_window(
        &self,
        hwnd: HWND,
        output: &mut RgbImage,
        screen: (i32, i32),
        regions: &[Rect],
        deadline: Instant,
    ) -> Result<(), String> {
        let capture = (|| -> windows::core::Result<()> {
            unsafe {
                let interop: IGraphicsCaptureItemInterop =
                    factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
                let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
                let size = item.Size()?;
                if size.Width <= 0
                    || size.Height <= 0
                    || size.Width as i64 * size.Height as i64 > 64_000_000
                {
                    return Err(windows::core::Error::from_hresult(
                        windows::Win32::Foundation::E_INVALIDARG,
                    ));
                }
                let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                    &self.projected,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    1,
                    size,
                )?;
                let session = match pool.CreateCaptureSession(&item) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = pool.Close();
                        return Err(e);
                    }
                };
                let snapshot = Snapshot { pool, session };
                // Do not request borderless privileges or change other applications' windows.
                let _ = snapshot.session.SetIsCursorCaptureEnabled(false);
                let (tx, rx) = mpsc::sync_channel(1);
                snapshot
                    .pool
                    .FrameArrived(&TypedEventHandler::new(move |_, _| {
                        let _ = tx.try_send(());
                        Ok(())
                    }))?;
                snapshot.session.StartCapture()?;
                let remaining = deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(600));
                rx.recv_timeout(remaining).map_err(|_| {
                    windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
                })?;
                let frame = snapshot.pool.TryGetNextFrame()?;
                let copied = (|| -> windows::core::Result<()> {
                    let content = frame.ContentSize()?;
                    // Reject a resize mid-sample instead of stretching pixels across authorization boundaries.
                    if content != size {
                        return Err(windows::core::Error::from_hresult(
                            windows::Win32::Foundation::E_FAIL,
                        ));
                    }
                    let bounds =
                        frame_bounds(hwnd, (size.Width, size.Height)).ok_or_else(|| {
                            windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
                        })?;
                    let surface: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
                    let texture: ID3D11Texture2D = surface.GetInterface()?;
                    let mut desc = D3D11_TEXTURE2D_DESC::default();
                    texture.GetDesc(&mut desc);
                    if desc.Width < size.Width as u32
                        || desc.Height < size.Height as u32
                        || desc.Width as u64 * desc.Height as u64 > 64_000_000
                    {
                        return Err(windows::core::Error::from_hresult(
                            windows::Win32::Foundation::E_FAIL,
                        ));
                    }
                    desc.Usage = D3D11_USAGE_STAGING;
                    desc.BindFlags = 0;
                    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                    desc.MiscFlags = 0;
                    let mut staging = None;
                    self.device
                        .CreateTexture2D(&desc, None, Some(&mut staging))?;
                    let staging = staging.ok_or_else(|| {
                        windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
                    })?;
                    self.context.CopyResource(&staging, &texture);
                    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                    self.context
                        .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                    let result =
                        if mapped.pData.is_null() || mapped.RowPitch < (size.Width as u32) * 4 {
                            Err(windows::core::Error::from_hresult(
                                windows::Win32::Foundation::E_FAIL,
                            ))
                        } else {
                            let bytes = std::slice::from_raw_parts(
                                mapped.pData.cast::<u8>(),
                                mapped.RowPitch as usize * size.Height as usize,
                            );
                            copy_regions(
                                output,
                                screen,
                                bounds,
                                regions,
                                bytes,
                                mapped.RowPitch as usize,
                            );
                            Ok(())
                        };
                    self.context.Unmap(&staging, 0);
                    result
                })();
                let _ = frame.Close();
                copied
            }
        })();
        capture.map_err(|error| {
            format!(
                "无法取得被忽略窗口下方的白名单画面，已丢弃此帧（{}）",
                error.code()
            )
        })
    }
}

unsafe fn frame_bounds(hwnd: HWND, size: (i32, i32)) -> Option<Rect> {
    unsafe {
        let mut dwm = RECT::default();
        let mut outer = RECT::default();
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut dwm as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        );
        let _ = GetWindowRect(hwnd, &mut outer);
        [dwm, outer]
            .into_iter()
            .find(|r| r.right - r.left == size.0 && r.bottom - r.top == size.1)
            .map(|r| Rect {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
            })
    }
}

fn copy_regions(
    output: &mut RgbImage,
    screen: (i32, i32),
    bounds: Rect,
    regions: &[Rect],
    bytes: &[u8],
    pitch: usize,
) {
    let sx = output.width() as f64 / screen.0 as f64;
    let sy = output.height() as f64 / screen.1 as f64;
    for region in regions {
        let left = (region.left as f64 * sx).ceil().max(0.) as u32;
        let top = (region.top as f64 * sy).ceil().max(0.) as u32;
        let right = (region.right as f64 * sx)
            .floor()
            .min(output.width() as f64)
            .max(0.) as u32;
        let bottom = (region.bottom as f64 * sy)
            .floor()
            .min(output.height() as f64)
            .max(0.) as u32;
        for y in top..bottom {
            for x in left..right {
                let screen_x = ((x as f64 + 0.5) / sx).floor() as i32;
                let screen_y = ((y as f64 + 0.5) / sy).floor() as i32;
                // Only this window's admitted regions may be copied, never the global union.
                if screen_x < region.left
                    || screen_x >= region.right
                    || screen_y < region.top
                    || screen_y >= region.bottom
                {
                    continue;
                }
                let source_x = screen_x - bounds.left;
                let source_y = screen_y - bounds.top;
                if source_x < 0
                    || source_y < 0
                    || source_x >= bounds.right - bounds.left
                    || source_y >= bounds.bottom - bounds.top
                {
                    continue;
                }
                let offset = source_y as usize * pitch + source_x as usize * 4;
                if let Some(p) = bytes.get(offset..offset + 4) {
                    output.put_pixel(x, y, image::Rgb([p[2], p[1], p[0]]));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_copy_preserves_masks_and_negative_origins() {
        let bounds = Rect {
            left: -2,
            top: -1,
            right: 6,
            bottom: 5,
        };
        let mut bytes = vec![0u8; 8 * 6 * 4];
        for y in 0..6 {
            for x in 0..8 {
                let i = (y * 8 + x) * 4;
                bytes[i..i + 4].copy_from_slice(&[x as u8, y as u8, 240, 255]);
            }
        }
        let mut output = RgbImage::new(6, 4);
        copy_regions(
            &mut output,
            (6, 4),
            bounds,
            &[Rect {
                left: 1,
                top: 1,
                right: 4,
                bottom: 3,
            }],
            &bytes,
            32,
        );
        assert_eq!(output.get_pixel(1, 1).0, [240, 2, 3]);
        assert_eq!(output.get_pixel(3, 2).0, [240, 3, 5]);
        assert_eq!(output.get_pixel(0, 1).0, [0, 0, 0]);
        assert_eq!(output.get_pixel(4, 2).0, [0, 0, 0]);
    }
    #[test]
    fn downsampling_never_reads_outside_authorized_region() {
        let bounds = Rect {
            left: 0,
            top: 0,
            right: 8,
            bottom: 8,
        };
        let bytes = vec![255u8; 8 * 8 * 4];
        let mut output = RgbImage::new(4, 4);
        copy_regions(
            &mut output,
            (8, 8),
            bounds,
            &[Rect {
                left: 1,
                top: 1,
                right: 5,
                bottom: 5,
            }],
            &bytes,
            32,
        );
        assert_eq!(output.get_pixel(1, 1).0, [255, 255, 255]);
        assert_eq!(output.get_pixel(0, 0).0, [0, 0, 0]);
        assert_eq!(output.get_pixel(2, 2).0, [0, 0, 0]);
    }
}
