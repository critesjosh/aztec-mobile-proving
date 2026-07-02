//! bb-chonk-prove: prove an `ivc-inputs.msgpack` step stack with the native
//! ClientIVC prover and emit the flat proof fields + hiding-kernel VK as JSON.
//!
//! This is the bridge the testnet harness drives (on the host, or pushed to an
//! Android device via adb). Output is written to a file to avoid megabyte JSON
//! over stdout/logcat.
//!
//! Usage:
//!   bb-chonk-prove <ivc-inputs.msgpack> <g1.dat> <g2.dat> <grumpkin_g1.dat> <out.json> \
//!                  [bn254_points] [grumpkin_points]
//!
//! Output JSON: { verified, num_circuits, prove_ms, total_ms, peak_rss_mb,
//!                vk (hex), proof_fields: [hex,...] }

use std::path::Path;

use noir_prover::{load_bn254_srs, load_grumpkin_srs, parse_ivc_inputs, NoirProver};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn peak_rss_mb() -> f64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    for line in status.lines() {
        if let Some(kb) = line.strip_prefix("VmHWM:") {
            let kb: f64 = kb.trim().trim_end_matches(" kB").trim().parse().unwrap_or(0.0);
            return (kb / 1024.0 * 10.0).round() / 10.0;
        }
    }
    0.0
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 6 {
        eprintln!(
            "usage: bb-chonk-prove <ivc-inputs.msgpack> <g1.dat> <g2.dat> <grumpkin_g1.dat> <out.json> [bn254_points] [grumpkin_points]"
        );
        std::process::exit(2);
    }
    let bn254_points: u32 = a.get(6).map(|s| s.parse().unwrap()).unwrap_or(1 << 19);
    let grumpkin_points: u32 = a.get(7).map(|s| s.parse().unwrap()).unwrap_or(1 << 16);

    let ivc = std::fs::read(&a[1]).expect("read ivc-inputs");
    let steps = parse_ivc_inputs(&ivc).expect("parse ivc-inputs");
    eprintln!("bb-chonk-prove: {} steps", steps.len());

    let srs = load_bn254_srs(Path::new(&a[2]), Path::new(&a[3]), bn254_points).expect("bn254 srs");
    let grumpkin = load_grumpkin_srs(Path::new(&a[4]), grumpkin_points).expect("grumpkin srs");

    let mut prover = NoirProver::new().expect("prover init");
    prover.init_srs(&srs).expect("init bn254 srs");
    prover
        .init_grumpkin_srs(&grumpkin, grumpkin_points)
        .expect("init grumpkin srs");
    drop(srs);
    drop(grumpkin);

    let out = prover.chonk_prove_flow(steps).expect("chonk prove");
    eprintln!(
        "bb-chonk-prove: verified={} prove={}ms total={}ms peak_rss={}MB fields={}",
        out.verified,
        out.prove_ms,
        out.total_ms,
        peak_rss_mb(),
        out.proof_fields.len()
    );

    let json = serde_json::json!({
        "verified": out.verified,
        "num_circuits": out.num_circuits,
        "prove_ms": out.prove_ms,
        "vk_ms": out.compute_vk_ms,
        "verify_ms": out.verify_ms,
        "total_ms": out.total_ms,
        "peak_rss_mb": peak_rss_mb(),
        "vk": hex(&out.vk),
        "proof_fields": out.proof_fields.iter().map(|f| hex(f)).collect::<Vec<_>>(),
    });
    std::fs::write(&a[5], serde_json::to_vec(&json).unwrap()).expect("write output");
    eprintln!("bb-chonk-prove: wrote {}", a[5]);
    if !out.verified {
        std::process::exit(1);
    }
}
