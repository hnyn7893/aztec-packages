#pragma once
#include "private_circuit_public_inputs.hpp"
#include "public_circuit_public_inputs.hpp"

#include "aztec3/constants.hpp"
#include "aztec3/utils/array.hpp"
#include "aztec3/utils/types/circuit_types.hpp"
#include "aztec3/utils/types/convert.hpp"
#include "aztec3/utils/types/native_types.hpp"

#include <barretenberg/barretenberg.hpp>

namespace aztec3::circuits::abis {

template <typename NCT> struct PrivateTypes {
    using AppCircuitPublicInputs = PrivateCircuitPublicInputs<NCT>;
    // used in schema serialization
    static constexpr char schema_name[] = "Private";  // NOLINT
};

template <typename NCT> struct PublicTypes {
    using AppCircuitPublicInputs = PublicCircuitPublicInputs<NCT>;
    // used in schema serialization
    static constexpr char schema_name[] = "Public";  // NOLINT
};
}  // namespace aztec3::circuits::abis
