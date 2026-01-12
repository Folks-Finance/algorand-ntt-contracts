import setuptools


with open("README.md", "r") as f:
    long_description = f.read()

setuptools.setup(
    name="algorand-ntt-contracts",
    description="Smart Contracts for Wormhole NTT on Algorand",
    author="Folks Finance",
    version="0.0.1",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/Folks-Finance/algorand-ntt-contracts",
    license="MIT",
    project_urls={
        "Source": "https://github.com/Folks-Finance/algorand-ntt-contracts",
    },
    install_requires=[
        "algokit>=2.9.1,<3",
        "algorand-python>=3.1.1,<4",
        "puyapy>=5.6.0,<6",
    ],
    packages=setuptools.find_packages(
        include=(
            "ntt_contracts",
            "ntt_contracts.*",
        )
    ),
    python_requires=">=3.12",
    package_data={"ntt_contracts": ["py.typed"]},
    include_package_data=True
)
