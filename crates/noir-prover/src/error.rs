use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProverError {
    #[error("artifact error: {0}")]
    Artifact(String),
    #[error("input encoding error: {0}")]
    Inputs(String),
    #[error("witness generation error: {0}")]
    Witgen(String),
    #[error("barretenberg error: {0}")]
    Barretenberg(#[from] barretenberg_rs::error::BarretenbergError),
    #[error("SRS error: {0}")]
    Srs(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ProverError>;
